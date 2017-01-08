import _ from 'lodash'

const worker = (() => {
  const DbWorker = require('./fairly-simple-db.worker')
  return new DbWorker()
})()

const waitingPromises = {}

const waitForWorkerResponse = id => new Promise((resolve, reject) => { waitingPromises[id] = {resolve, reject} })

worker.onmessage = message => {
  const {id, payload, error} = message.data
  const waitingPromise = waitingPromises[id]
  if (waitingPromise) {
    if (error)
      waitingPromise.reject(error)
    else
      waitingPromise.resolve(payload)
  }
  delete waitingPromises[id]
}

let idx = 0

export class DB {
  constructor(dbName) {
    this.dbName = dbName
    this._messages = []
  }

  version(version) {
    if (! this.version)
      throw new Error('can only call version() once')
    this.version = version
    return this
  }

  _postAndReceive(data) {
    const id = (++idx).toString(36)
    data.id = id
    this._scheduleMessage(data)
    return waitForWorkerResponse(id)
  }

  _scheduleMessage(message) {
    this._messages.push(message)
    this._flushMessagesOnNextTick()
  }

  _flushMessagesOnNextTick = _.debounce(() => {
    worker.postMessage(JSON.stringify(this._messages))
    this._messages.splice(0)
  }, 0)

  async stores(stores) {
    const {version, dbName} = this
    if (! version)
      throw new Error('must call version() before stores()')

    await this._postAndReceive({ type: 'create', dbName, version, stores })
    return this
  }

  put(storeName, ...documents) {
    const {dbName} = this
    return this._postAndReceive({ type: 'put', dbName, args: [storeName, documents] })
  }

  delete(storeName, id) {
    const {dbName} = this
    return this._postAndReceive({ type: 'delete', dbName, args: [storeName, id] })
  }

  clear(storeName) {
    const {dbName} = this
    return this._postAndReceive({ type: 'clear', dbName, args: [storeName] })
  }

  getAll(storeName) {
    const {dbName} = this
    return this._postAndReceive({ type: 'getAll', dbName, args: [storeName] })
  }
}

const dbFactoryPromises = {}
export function openDb(dbName, callback) {
  const factoryPromise = dbFactoryPromises[dbName]
  if (factoryPromise)
    return factoryPromise

  const db = new DB(dbName)
  return dbFactoryPromises[dbName] = callback(db)
}
