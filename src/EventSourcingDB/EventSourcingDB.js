/* eslint-disable no-console */
// Event Sourcing DataBase
// * Only allows changes via messages that are stored and processed. This allows easy
//   replication, debugging and possibly even rollback
// * All the database tables participating should only be changed via events
// * The current version is stored in the SQLite `user_version` pragma and corresponds to the last event applied
// * Events describe facts that happened
//   * Think of them as newspaper clippings (that changed) or notes passed to the kitchen (this change requested)
//   * Should not require outside-db data to know how to handle them. Otherwise, split them in parts
// * Models store the data in a table an define preprocessor, reducer, applyEvent and deriver
// * Events:
//   * have version `v`, strictly ordered
//   * are added to `history` table in a single transaction, and then processed asynchronously in a separate transaction
//   * result of processing is stored in `history`
// * Each event is handled separately and serially in a single transaction:
//   * Preprocessors canonicalize the event
//   * Reducers get the table at `v-1` and the event, and describe the change for version `v` into a result object
//   * Once all reducers ran, the result objects are passed to model.applyEvent that changes the db
//   * Then the derivers run, they can post-process the db for calculating or caching
//     * Another option is a writable table with lazy user-space calculation. Delete entries in the deriver when they become invalid
//   * Then the transaction completes and the db is at version `v`
//   * Only applyEvent and deriver get a writeable db
// * Sub-events can be emitted at any point during processing
//   * for example USER_REGISTERED results in USER_ADD and EMAIL_OUT
//   * they are processed exactly like events but in the transaction of the parent event, in-process
//   * sub-events are stored in the event in a `sub` array, for reporting and debugging
// * To make changes to a table, change the reducer and rebuild the DB with the history, or migrate the table
//
// Extra notes:
// * preprocessors should always process events statelessly - processing again should be no problem
// * preprocessors, reducers, derivers should be pure, only working with the database state.
// * To incorporate external state in event processing, split the event up in multiple events recording current state, and listen to the db to know what to do

// * Ideally, reducers etc never fail
// * When they fail, the whole app hangs for new events
// * therefore all failures are exceptional and need intervention like app restart for db issues
// * => warn immediately with error when it happens
// * => make changing event easy, e.g. call queue.set from graphql or delete it by changing it to type 'HANDLE_FAILED' and rename .error

import debug from 'debug'
import {isEmpty} from 'lodash'
import DB from '../DB'
import ESModel from '../ESModel'
import EventQueue from '../EventQueue'
import EventEmitter from 'events'
import {settleAll} from '../lib/settleAll'

const dbg = debug('stratokit/ESDB')

const wait = ms => new Promise(r => setTimeout(r, ms))

const registerHistoryMigration = (rwDb, queue) => {
	rwDb.registerMigrations('historyExport', {
		2018040800: {
			up: async db => {
				const oldTable = await db.all('PRAGMA table_info(history)')
				if (
					!(
						oldTable.length === 4 &&
						oldTable.some(c => c.name === 'json') &&
						oldTable.some(c => c.name === 'v') &&
						oldTable.some(c => c.name === 'type') &&
						oldTable.some(c => c.name === 'ts')
					)
				)
					return
				let allDone = Promise.resolve()
				await db.each('SELECT * from history', row => {
					allDone = allDone.then(() =>
						queue.set({...row, json: undefined, ...JSON.parse(row.json)})
					)
				})
				await allDone
				// not dropping table, you can do that yourself :)
				console.error(`!!! history table in ${rwDb.file} is no longer needed`)
			},
		},
	})
}

const errorToString = error => {
	const msg = error
		? error.stack || error.message || String(error)
		: new Error('missing error').stack
	return String(msg).replace(/\s+/g, ' ')
}

class ESDB extends EventEmitter {
	MAX_RETRY = 38 // this is an hour

	// eslint-disable-next-line complexity
	constructor({queue, models, queueFile, withViews = true, ...dbOptions}) {
		super()
		if (dbOptions.db)
			throw new TypeError(
				'db is no longer an option, pass the db options instead, e.g. file, verbose, readOnly'
			)
		if (!models) throw new TypeError('models are required')
		if (queueFile && queue)
			throw new TypeError('Either pass queue or queueFile')

		this.rwDb = new DB(dbOptions)
		const {readOnly} = this.rwDb

		// The RO DB needs to be the same for :memory: or it won't see anything
		this.db =
			this.rwDb.file === ':memory:' || readOnly
				? this.rwDb
				: new DB({
						...dbOptions,
						name: dbOptions.name && `RO-${dbOptions.name}`,
						readOnly: true,
						onWillOpen: async () => {
							// Make sure migrations happened before opening
							await this.queue.db.openDB()
							await this.rwDb.openDB()
						},
				  })

		if (queue) {
			this.queue = queue
		} else {
			const qDb = new DB({
				...dbOptions,
				name: `${dbOptions.name || ''}Queue`,
				file: queueFile || this.rwDb.file,
			})
			this.queue = new EventQueue({
				db: qDb,
				withViews,
				columns: {events: {type: 'JSON'}},
			})
		}
		const qDbFile = this.queue.db.file
		// If queue is in same file as rwDb, share the connection
		// for writing results during transaction - no deadlocks
		this._resultQueue =
			this.rwDb.file === qDbFile && qDbFile !== ':memory:'
				? new EventQueue({db: this.rwDb})
				: this.queue

		// Move old history data to queue DB
		if (this.rwDb.file !== qDbFile) {
			registerHistoryMigration(this.rwDb, this.queue)
		}
		this.rwDb.registerMigrations('ESDB', {
			// Move v2 metadata version to DB user_version
			userVersion: async db => {
				const {user_version: uv} = await db.get('PRAGMA user_version')
				if (uv) return // Somehow we already have a version
				const hasMetadata = await db.get(
					'SELECT 1 FROM sqlite_master WHERE name="metadata"'
				)
				if (!hasMetadata) return
				const vObj = await db.get(
					'SELECT json_extract(json, "$.v") AS v FROM metadata WHERE id="version"'
				)
				const v = vObj && Number(vObj.v)
				if (!v) return
				await db.run(`PRAGMA user_version=${v}`)
				const {count} = await db.get(`SELECT count(*) AS count from metadata`)
				if (count === 1) {
					await db.exec(
						`DROP TABLE metadata; DELETE FROM _migrations WHERE runKey="0 metadata"`
					)
				} else {
					await db.run(`DELETE FROM metadata WHERE id="version"`)
				}
			},
		})

		this.store = {}
		this.rwStore = {}

		this.reducerNames = []
		this.deriverModels = []
		this.preprocModels = []
		this.readWriters = []
		const reducers = {}
		this.reducerModels = {}
		const migrationOptions = {queue: this.queue}

		const dispatch = this.dispatch.bind(this)
		for (const [name, modelDef] of Object.entries(models)) {
			try {
				if (!modelDef) throw new Error('model missing')
				let {
					reducer,
					preprocessor,
					deriver,
					Model = ESModel,
					RWModel = Model,
					...rest
				} = modelDef

				if (RWModel === ESModel) {
					if (reducer) {
						const prev = reducer
						reducer = async (model, event) => {
							const result = await prev(model, event)
							if (!result && event.type === model.TYPE)
								return ESModel.reducer(model, event)
							return result
						}
					}
					if (preprocessor) {
						const prev = preprocessor
						preprocessor = async args => {
							const e = await ESModel.preprocessor(args)
							if (e) args.event = e
							return prev(args)
						}
					}
				}
				let hasOne = false

				const rwModel = this.rwDb.addModel(RWModel, {
					name,
					...rest,
					migrationOptions,
					dispatch,
				})
				rwModel.deriver = deriver || RWModel.deriver
				this.rwStore[name] = rwModel
				if (typeof rwModel.setWritable === 'function')
					this.readWriters.push(rwModel)
				if (rwModel.deriver) {
					this.deriverModels.push(rwModel)
					hasOne = true
				}

				let model
				if (this.db === this.rwDb) {
					model = rwModel
				} else {
					model = this.db.addModel(Model, {name, ...rest, dispatch})
				}
				model.preprocessor = preprocessor || Model.preprocessor
				model.reducer = reducer || Model.reducer
				this.store[name] = model
				if (model.preprocessor) {
					this.preprocModels.push(model)
					hasOne = true
				}
				if (model.reducer) {
					this.reducerNames.push(name)
					this.reducerModels[name] = model
					reducers[name] = model.reducer
					hasOne = true
				}

				if (!hasOne)
					throw new TypeError(
						`${
							this.name
						}: At least one reducer, deriver or preprocessor required`
					)
			} catch (error) {
				// TODO write test
				if (error.message)
					error.message = `ESDB: while configuring model ${name}: ${
						error.message
					}`
				if (error.stack)
					error.stack = `ESDB: while configuring model ${name}: ${error.stack}`
				throw error
			}
		}

		if (!readOnly) {
			this.checkForEvents()
		}
	}

	close() {
		return Promise.all([
			this.rwDb && this.rwDb.close(),
			this.db !== this.rwDb && this.db.close(),
			this.queue.db.close(),
		])
	}

	checkForEvents() {
		this.startPolling(1)
	}

	_waitingP = null

	_minVersion = 0

	startPolling(wantVersion) {
		if (wantVersion) {
			if (wantVersion > this._minVersion) this._minVersion = wantVersion
		} else if (!this._isPolling) {
			this._isPolling = true
			if (module.hot) {
				module.hot.dispose(() => {
					this.stopPolling()
				})
			}
		}
		if (!this._waitingP) {
			this._waitingP = this._waitForEvent()
				.catch(error => {
					console.error(
						'!!! Error waiting for event! This should not happen! Please investigate!',
						error
					)
					// Crash program but leave some time to notify
					if (process.env.NODE_ENV !== 'test')
						// eslint-disable-next-line unicorn/no-process-exit
						setTimeout(() => process.exit(100), 500)

					throw new Error(error)
				})
				.then(lastV => {
					this._waitingP = null
					// Subtle race condition: new wantVersion coming in between end of _wait and .then
					// lastV is falsy when forcing a stop
					if (lastV != null && this._minVersion && lastV < this._minVersion)
						return this.startPolling(this._minVersion)
					this._minVersion = 0
					return undefined
				})
		}
		return this._waitingP
	}

	stopPolling() {
		this._isPolling = false
		// here we should cancel the getNext
		this._reallyStop = true
		return this._waitingP || Promise.resolve()
	}

	async dispatch(type, data, ts) {
		const event = await this.queue.add(type, data, ts)
		return this.handledVersion(event.v)
	}

	// Only use this for testing
	async _dispatchWithError(type, data, ts) {
		const event = await this.queue.add(type, data, ts)
		this._stopPollingOnError = true
		await this.startPolling(event.v)
		const result = await this.queue.get(event.v)
		if (result.error) throw result
		return result
	}

	_subDispatch(event, type, data) {
		if (!event.events) event.events = []
		event.events.push({type, data})
	}

	getVersionP = null

	getVersion() {
		if (!this.getVersionP) {
			this.getVersionP = this.db
				.get('PRAGMA user_version')
				.then(u => u.user_version)
				.finally(() => {
					this.getVersionP = null
				})
		}
		return this.getVersionP
	}

	async waitForQueue() {
		const v = await this.queue._getLatestVersion()
		return this.handledVersion(v)
	}

	_waitingFor = {}

	_maxWaitingFor = 0

	async handledVersion(v) {
		if (!v) return
		// We must get the version first because our history might contain future events
		if (v <= (await this.getVersion())) {
			const event = await this.queue.get(v)
			if (event.error) {
				// This can only happen if we skipped a failed event
				return Promise.reject(event)
			}
			return event
		}
		if (!this._waitingFor[v]) {
			if (v > this._maxWaitingFor) this._maxWaitingFor = v
			const o = {}
			this._waitingFor[v] = o
			o.promise = new Promise((resolve, reject) => {
				o.resolve = resolve
				o.reject = reject
			})
			this.startPolling(v)
		}
		return this._waitingFor[v].promise
	}

	// TODO handle DB errors while getting the events from history
	_triggerEventListeners(event) {
		const o = this._waitingFor[event.v]
		if (o) delete this._waitingFor[event.v]

		if (event.v >= this._maxWaitingFor) {
			// Normally this will be empty but we might encounter a race condition
			for (const vStr of Object.keys(this._waitingFor)) {
				const v = Number(vStr)
				if (v > event.v) continue
				// eslint-disable-next-line promise/catch-or-return
				this.queue.get(v).then(event => this._triggerEventListeners(event))
				delete this._waitingFor[v]
			}
		}

		// Note that error events don't increase the DB version
		if (event.error) {
			// emit 'error' throws if there is no listener
			if (this.listenerCount('error')) {
				try {
					this.emit('error', event)
				} catch (error) {
					console.error('!!! "error" event handler threw, ignoring', error)
				}
			}
		} else {
			try {
				this.emit('result', event)
			} catch (error) {
				console.error('!!! "result" event handler threw, ignoring', error)
			}
			if (o) o.resolve(event)
		}
	}

	// This is the loop that applies events from the queue. Use startPolling(false) to always poll
	// so that events from other processes are also handled
	// It would be nice to not have to poll, but sqlite triggers only work on
	// the connection that makes the change
	// This should never throw, handling errors can be done in apply
	_waitForEvent = async () => {
		/* eslint-disable no-await-in-loop */
		const {rwDb} = this
		let lastV = 0
		let errorCount = 0
		if (dbg.enabled && this._minVersion)
			dbg(`waiting for events until minVersion: ${this._minVersion}`)
		while (!this._minVersion || this._minVersion > lastV) {
			if (errorCount) {
				if (errorCount > this.MAX_RETRY)
					throw new Error(`Giving up on processing event ${lastV + 1}`)
				// These will reopen automatically
				if (this.db.file !== ':memory:') this.db.close()
				if (this.rwDb.file !== ':memory:') this.rwDb.close()
				if (this.queue.db.file !== ':memory:') this.queue.db.close()
				await wait(5000 * errorCount)
			}
			let event
			try {
				// eslint-disable-next-line require-atomic-updates
				event = await this.queue.getNext(
					await this.getVersion(),
					!(this._isPolling || this._minVersion)
				)
			} catch (error) {
				errorCount++
				console.error(
					`!!! ESDB: queue.getNext failed - this should not happen`,
					error
				)
				continue
			}
			if (!event) return lastV
			// TODO watchdog with timeout alerts/abort
			const resultEvent = await rwDb
				.withTransaction(async () => {
					lastV = event.v

					// It could be that it was processed elsewhere due to racing
					const nowV = await this.getVersion()
					if (event.v <= nowV) return

					// Clear previous result/error, if any
					delete event.error
					delete event.result

					await rwDb.run('SAVEPOINT handle')
					const result = await this._handleEvent(event)
					if (result.error) {
						// Undo all changes, but retain the event info
						await rwDb.run('ROLLBACK TO SAVEPOINT handle')
						if (result.result) {
							result.failedResult = result.result
							delete result.result
						}
					} else {
						await rwDb.run('RELEASE SAVEPOINT handle')
					}
					return this._resultQueue.set(result)
				})
				.catch(error => {
					if (!this.__BE_QUIET)
						console.error(
							'!!! ESDB: an error occured outside of the normal error handlers',
							error
						)
					return {
						...event,
						error: {_SQLite: errorToString(error)},
					}
				})
			if (!resultEvent) continue // Another process handled the event

			if (resultEvent.error) {
				if (!this.__BE_QUIET)
					console.error(
						`!!! ESDB: event ${event.type} processing failed`,
						resultEvent.error
					)
				errorCount++
				lastV = resultEvent.v - 1
			} else errorCount = 0

			this._triggerEventListeners(resultEvent)

			if (this._reallyStop || (errorCount && this._stopPollingOnError)) {
				this._reallyStop = false
				return
			}
		}
		return lastV
		/* eslint-enable no-await-in-loop */
	}

	async _preprocessor(event) {
		for (const model of this.preprocModels) {
			const {name} = model
			const {store} = this
			const {v, type} = event
			let newEvent
			try {
				// eslint-disable-next-line no-await-in-loop
				newEvent = await model.preprocessor({
					event,
					model,
					store,
					dispatch: this._subDispatch.bind(this, event),
				})
			} catch (error) {
				newEvent = {error}
			}
			// mutation allowed
			if (!newEvent) newEvent = event
			if (!newEvent.error) {
				// Just in case event was mutated
				if (newEvent.v !== v)
					newEvent.error = new Error(`preprocessor must retain event version`)
				else if (!newEvent.type)
					newEvent.error = new Error(`preprocessor must retain event type`)
			}
			if (newEvent.error) {
				return {
					...event,
					v,
					type,
					error: {
						[`_preprocess_${name}`]: errorToString(newEvent.error),
					},
				}
			}
			// allow other preprocessors to alter the event
			event = newEvent
		}
		return event
	}

	async _reducer(event) {
		const result = {}
		const events = event.events || []
		await Promise.all(
			this.reducerNames.map(async key => {
				const model = this.reducerModels[key]
				let out
				try {
					out = await model.reducer(model, event)
				} catch (error) {
					out = {
						error: errorToString(error),
					}
				}
				// in <v3 we allowed returning the model to indicate no change
				if (!out || out === model) return
				if (out.events) {
					if (!Array.isArray(out.events)) {
						result[key] = {error: `.events is not an array`}
						return
					}
					events.push(...out.events)
					delete out.events
				} else if ('events' in out) {
					// allow falsy events
					delete out.events
				}
				result[key] = out
			})
		)

		if (this.reducerNames.some(n => result[n] && result[n].error)) {
			const error = {}
			for (const name of this.reducerNames) {
				const r = result[name]
				if (r && r.error) {
					error[`reduce_${name}`] = r.error
				}
			}
			return {...event, error}
		}

		const resultEvent = {
			...event,
			result,
		}
		if (events.length) resultEvent.events = events
		return resultEvent
	}

	async _handleEvent(origEvent, depth = 0) {
		let event
		if (depth > 100) {
			return {
				...origEvent,
				error: {
					...origEvent.error,
					_handle: 'events recursing too deep',
				},
			}
		}
		event = await this._preprocessor(origEvent)
		if (event.error) return event

		event = await this._reducer(origEvent)
		if (event.error) return event

		event = await this._applyEvent(event, depth === 0)
		if (event.error) return event

		// handle sub-events in order
		if (event.events) {
			for (let i = 0; i < event.events.length; i++) {
				const subEvent = event.events[i]
				// eslint-disable-next-line no-await-in-loop
				const doneEvent = await this._handleEvent(
					{...subEvent, v: event.v},
					depth + 1
				)
				delete doneEvent.v
				event.events[i] = doneEvent
				if (doneEvent.error) {
					if (doneEvent.result) {
						doneEvent.failedResult = doneEvent.result
						delete doneEvent.result
					}
					event.error = {_handle: `subevent ${i} failed`}
					return event
				}
			}
		}

		return event
	}

	async _applyEvent(event, updateVersion) {
		const {rwStore, rwDb, readWriters} = this
		let phase = '???'
		try {
			for (const model of readWriters) model.setWritable(true)
			const {result} = event

			if (result && !isEmpty(result)) {
				phase = 'apply'
				// Apply reducer results, wait for all to settle
				await settleAll(
					Object.entries(result),
					async ([name, r]) => r && rwStore[name].applyChanges(r)
				)
			}

			if (updateVersion) {
				phase = 'version'
				await rwDb.run(`PRAGMA user_version=${event.v}`)
			}

			// Apply derivers
			if (!event.error && this.deriverModels.length) {
				phase = 'derive'
				await settleAll(this.deriverModels, async model =>
					model.deriver({
						model,
						// TODO would this not better be the RO store?
						store: this.rwStore,
						event,
						result,
						dispatch: this._subDispatch.bind(this, event),
					})
				)
			}
		} catch (error) {
			if (event.result) {
				event.failedResult = event.result
				delete event.result
			}
			if (!event.error) event.error = {}
			// TODO test apply errors
			event.error[`_apply-${phase}`] = errorToString(error)
		} finally {
			for (const model of readWriters) model.setWritable(false)
		}

		return event
	}
}

export default ESDB
