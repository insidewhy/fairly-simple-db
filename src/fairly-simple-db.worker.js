import _ from 'lodash'

class DB {
  constructor(dbName, version) {
    this._db = null
    this._transaction = null
    this.dbName = dbName
    this.version = version
  }

  stores(stores) {
    const {dbName, version} = this

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, version)
      let upgradeWasNeeded = false

      request.onerror = event => {
        reject(new Error('failed to open indexeddb'))
      }

      request.onsuccess = event => {
        if (! upgradeWasNeeded) {
          this._db = event.target.result
          resolve(this)
        }
      }

      request.onupgradeneeded = event => {
        // console.debug('upgrading local database %s to verson %s', dbName, version)
        upgradeWasNeeded = true
        this._db = event.target.result
        this._upgradeStores(stores)
        .then(() => { resolve(this) })
        .catch(e => { reject(e) })
      }
    })
  }

  _upgradeStores(storesMeta) {
    return Promise.all(_.map(storesMeta, (storeKeys, storeName) => {
      return new Promise((resolve, reject) => {
        const [keyPath, ...keys] = (storeKeys || 'id').split(',')

        // if the object store already exists it must be deleted
        if (this._db.objectStoreNames.contains(storeName)) {
          console.debug('deleting existing object store')
          this._db.deleteObjectStore(storeName)
        }

        const objectStore = this._db.createObjectStore(storeName, { keyPath })

        // then create new indexes
        if (keys.length) {
          keys.forEach(keyName => {
            const unique = keyName[0] === '!'
            if (unique)
              keyName = keyName.substr(1)
            objectStore.createIndex(keyName, keyName, { unique })
          })
        }
        objectStore.transaction.oncomplete = () => { resolve() }
        objectStore.transaction.onerror = event => { reject(new Error(event.target.error)) }
      })
    }))
  }

  // force everything that happens in the same tick into a single transaction... hah
  _withTransaction(storeName, type, work) {
    let {_transaction: transaction} = this

    if (! transaction) {
      transaction = { type, workUnits: [], storeNames: [storeName] }

      transaction.promise = Promise.resolve().then(() => new Promise((resolve, reject) => {
        let results
        // make sure type is reread from transaction in case it has been upgraded
        const dbTransaction = this._db.transaction(transaction.storeNames, transaction.type)
        dbTransaction.onerror = event => { reject(new Error(event.target.error)) }
        dbTransaction.oncomplete = () => { resolve(results) }

        results = transaction.workUnits.map(({work, storeName}) => work(dbTransaction.objectStore(storeName)))
        this._transaction = null
      }))
    }
    else {
      const {storeNames} = transaction
      if (storeNames.indexOf(storeName) === -1)
        storeNames.push(storeName)

      // can upgrade readonly transactions to readwrite
      if (type === 'readwrite')
        transaction.type = type
    }

    const unitIdx = transaction.workUnits.length
    transaction.workUnits.push({work, storeName})
    // resolves the promise if work() returns one.
    return transaction.promise.then(results => results[unitIdx])
  }

  put(storeName, documents) {
    return this._withTransaction(storeName, 'readwrite', objectStore => {
      documents.forEach(doc => { objectStore.put(doc) })
    })
  }

  delete(storeName, id) {
    return this._withTransaction(storeName, 'readwrite', objectStore => {
      objectStore.delete(id)
    })
  }

  clear(storeName) {
    return this._withTransaction(storeName, 'readwrite', objectStore => {
      objectStore.clear()
    })
  }

  getAll(storeName) {
    return this._withTransaction(storeName, 'readonly', objectStore => {
      const documents = []
      if ('getAll' in objectStore) {
        const query = objectStore.getAll()
        query.onsuccess = event => {
          documents.push(...event.target.result)
        }
      }
      else {
        const cursorRequest = objectStore.openCursor()
        cursorRequest.onsuccess = event => {
          const cursor = event.target.result
          if (cursor) {
            documents.push(cursor.value)
            cursor.continue()
          }
        }
      }

      // it will be mutated to contain all the results by the time oncomplete is called
      return documents
    })
  }
}

const allDbs = {}

self.onmessage = message => {
  const subMessages = JSON.parse(message.data)

  subMessages.forEach(data => {
    const {type, id} = data
    if (type === 'create') {
      const {dbName, version, stores} = data
      const db = allDbs[dbName] = new DB(dbName, version)
      db.stores(stores).then(() => {
        self.postMessage({id, payload: true})
      })
      .catch(err => {
        self.postMessage({id, error: err.toString()})
      })
      return
    }

    const {dbName} = data
    const db = allDbs[dbName]
    if (! db) {
      self.postMessage({id, error: `database ${dbName} does not exist`})
      return
    }

    const {args} = data
    db[type](...args)
    .then(payload => { self.postMessage({id, payload}) })
    .catch(err => { self.postMessage({id, error: err.toString()}) })
  })
}
