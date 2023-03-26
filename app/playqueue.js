'use strict'

var libQ = require('kew')
var fs = require('fs-extra')
var exec = require('child_process').exec
const NodeCache = require('node-cache')

class CorePlayQueue {
  constructor(commandRouter, stateMachine) {
    var self = this

    this.commandRouter = commandRouter
    this.stateMachine = stateMachine
    this.arrayQueue = []

    this.defaultSampleRate = ''
    this.defaultBitdepth = 0
    this.defaultChannels = 0

    this.preloadStop = false
    this.preloadQueue = []

    this.cache = new NodeCache()

    // trying to read play queue from file
    var persistentqueue = this.commandRouter.executeOnPlugin(
      'music_service',
      'mpd',
      'getConfigParam',
      'persistent_queue'
    )
    if (persistentqueue == undefined) {
      persistentqueue = true
    }

    if (persistentqueue) {
      fs.readJson('/data/queue', function (err, queue) {
        if (err) {
          self.commandRouter.logger.info('Cannot read play queue from file')
        } else {
          self.commandRouter.logger.info('Reloading queue from file')
          // self.commandRouter.logger.info(queue);
          self.arrayQueue = queue
        }
      })
    } else {
      exec('echo "" > /data/queue', function (error) {
        if (error !== null) {
          console.log('Cannot empty queue')
        }
      })
    }
  }

  getQueue() {
    this.commandRouter.pushConsoleMessage('CorePlayQueue::getQueue')
    return this.arrayQueue
  }

  getTrackBlock(nStartIndex) {
    this.commandRouter.pushConsoleMessage('CorePlayQueue::getTrackBlock')
    // jpa hack workaround for now....
    var goodIndex = Math.min(this.arrayQueue.length - 1, nStartIndex)
    if (this.arrayQueue[goodIndex]) {
      var sTargetService = this.arrayQueue[goodIndex].service
    } else {
      return {service: 'mpd', uris: '', startindex: ''}
    }

    var nEndIndex = goodIndex
    var nToCheck = this.arrayQueue.length - 1

    while (nEndIndex < nToCheck) {
      if (this.arrayQueue[nEndIndex + 1].service !== sTargetService) {
        break
      }
      nEndIndex++
    }

    var arrayUris = this.arrayQueue.slice(nStartIndex, nEndIndex + 1).map(function (curTrack) {
      return curTrack.uri
    })

    return {service: sTargetService, uris: arrayUris, startindex: nStartIndex}
  }

  removeQueueItem(nIndex) {
    this.commandRouter.pushConsoleMessage('CorePlayQueue::removeQueueItem ' + nIndex.value)
    var item = this.arrayQueue.splice(nIndex.value, 1)

    // this.commandRouter.logger.info(JSON.stringify(item));
    this.saveQueue()

    var name = ''
    if (item[0] && item[0].name) {
      name = item[0].name
    }
    this.commandRouter.pushToastMessage(
      'success',
      this.commandRouter.getI18nString('COMMON.REMOVE_QUEUE_TITLE'),
      this.commandRouter.getI18nString('COMMON.REMOVE_QUEUE_TEXT_1') +
        name +
        this.commandRouter.getI18nString('COMMON.REMOVE_QUEUE_TEXT_2')
    )

    var defer = libQ.defer()
    this.commandRouter
      .volumioPushQueue(this.arrayQueue)
      .then(function () {
        defer.resolve({})
      })
      .fail(function (err) {
        defer.reject(new Error(err))
      })

    return defer.promise
  }

  async removeItemsAfterIndex(index) {
    this.commandRouter.pushConsoleMessage('CorePlayQueue::removeItemsAfterIndex ' + index)
    this.arrayQueue = this.arrayQueue.slice(0, index + 1)
    this.saveQueue()
    await this.commandRouter.volumioPushQueue(this.arrayQueue)
  }

  explodeUriFromCache(service, uri) {
    var self = this
    var defer = libQ.defer()
    var value = self.cache.get(uri)

    if (value && Array.isArray(value)) {
      self.commandRouter.logger.info('Using cached record of: ' + uri)
      return value
    } else {
      self.commandRouter
        .explodeUriFromService(service, uri)
        .then((result) => {
          self.cache.set(uri, result, 3600)
          defer.resolve(result)
        })
        .fail((error) => {
          this.logger.error('PlayQueue: Cannot explode uri ' + uri + ' from service ' + service + ': ' + error)
          defer.resolve()
        })
      return defer.promise
    }
  }

  preLoadItems(items) {
    var self = this
    var timeOut = 50
    this.clearPreloadQueue()
    items.slice(0, 100).forEach((item) => {
      if (item.uri != undefined && item.type === 'song') {
        var value = self.cache.get(item.uri)
        if (value == undefined) {
          try {
            self.commandRouter.logger.info('Preloading ' + item.type + ': ' + item.uri)

            self.preloadQueue.push(
              setTimeout(function () {
                self.cache.set(item.uri, libQ.resolve(self.explodeUri(item), 3600))
              }, timeOut)
            )
            timeOut += 50
          } catch (error) {
            self.commandRouter.logger.error('Preload failed for uri: ' + item.uri + ': ' + error)
          }
        }
      }
    })
  }

  clearPreloadQueue() {
    var self = this
    self.preloadQueue.forEach((preloadItem) => {
      clearTimeout(preloadItem)
    })
    self.preloadQueue = []
    self.commandRouter.logger.info('Preload queue cleared')
  }

  explodeUri(item) {
    var self = this
    var service = 'mpd'

    if (item.service) {
      service = item.service

      if (item.uri.startsWith('cdda:')) {
        item.name = item.title
        if (!item.albumart) {
          item.albumart = '/albumart'
        }
        return libQ.resolve(item)
      } else if (service === 'webradio') {
        return self.commandRouter.executeOnPlugin('music_service', 'webradio', 'explodeUri', item)
      } else {
        return self.explodeUriFromCache(service, item.uri)
      }
    } else {
      // backward compatibility with SPOP plugin
      if (item.uri.startsWith('spotify:')) {
        service = 'spop'
      }

      return self.explodeUriFromCache(service, item.uri)
    }
  }

  addQueueItems(arrayItems) {
    var self = this
    var defer = libQ.defer()
    this.commandRouter.pushConsoleMessage('CorePlayQueue::addQueueItems')
    self.clearPreloadQueue()
    var firstItemIndex = this.arrayQueue.length
    var promiseArray = []
    var items = []
    if (!Array.isArray(arrayItems)) items = [].concat(arrayItems)
    else items = arrayItems

    for (const item of items) {
      if (item.uri != undefined) {
        self.commandRouter.logger.info('Adding Item to queue: ' + item.uri)
        promiseArray.push(self.explodeUri(item))
      }
    }

    libQ
      .all(promiseArray)
      .then(function (content) {
        var contentArray = []
        for (var j in content) {
          if (content[j]) {
            if (content[j].samplerate === undefined) {
              content[j].samplerate = self.defaultSampleRate
            }
            if (content[j].bitdepth === undefined) {
              content[j].bitdepth = self.defaultBitdepth
            }
            if (content[j].channels === undefined) {
              content[j].channels = self.defaultChannels
            }
            contentArray = contentArray.concat(content[j])
          }
        }

        if (self.arrayQueue.length > 0 && self.arrayQueue.length >= contentArray.length) {
          var queueLastElementsObj = self.arrayQueue.slice(Math.max(self.arrayQueue.length - contentArray.length, 0))
          var addQueueElementsObj = contentArray
          // If the array we are adding to queue is equal to the last elements of the queue, we don't add it and send index as first item of array we want to add
          if (self.compareTrackListByUri(queueLastElementsObj, addQueueElementsObj)) {
            firstItemIndex = self.arrayQueue.length - contentArray.length
          } else {
            self.arrayQueue = self.arrayQueue.concat(contentArray)
          }
        } else {
          self.arrayQueue = self.arrayQueue.concat(contentArray)
        }

        self.commandRouter.volumioPushQueue(self.arrayQueue)
        self.saveQueue()
      })
      .then(function () {
        self.stateMachine.updateTrackBlock()
        defer.resolve({firstItemIndex: firstItemIndex})
      })
      .fail(function (e) {
        defer.reject(new Error(e))
        self.commandRouter.logger.info('An error occurred while exploding URI: ' + e)
      })
    return defer.promise
  }

  clearAddPlayQueue(arrayItems) {
    this.commandRouter.pushConsoleMessage('CorePlayQueue::clearAddPlayQueue')
    this.arrayQueue = []
    this.arrayQueue = this.arrayQueue.concat(arrayItems)
    this.saveQueue()

    this.commandRouter.serviceClearAddPlayTracks(arrayItems, arrayItems[0].service)
    return this.commandRouter.volumioPushQueue(this.arrayQueue)
  }

  clearPlayQueue(sendEmptyState) {
    this.commandRouter.pushConsoleMessage('CorePlayQueue::clearPlayQueue')
    this.arrayQueue = []
    this.saveQueue()

    if (sendEmptyState) {
      this.commandRouter.stateMachine.pushEmptyState()
    }

    return this.commandRouter.volumioPushQueue(this.arrayQueue)
  }

  getTrack(index) {
    this.commandRouter.pushConsoleMessage('CorePlayQueue::getTrack ' + index)

    if (this.arrayQueue.length > index) {
      return this.arrayQueue[index]
    } else return
  }

  moveQueueItem(from, to) {
    this.commandRouter.pushConsoleMessage('CorePlayQueue::moveQueueItem ' + from + ' --> ' + to)

    if (this.arrayQueue.length > to) {
      this.arrayQueue.splice(to, 0, this.arrayQueue.splice(from, 1)[0])
      return this.commandRouter.volumioPushQueue(this.arrayQueue)
    } else return libQ.resolve()
  }

  saveQueue() {
    var self = this
    this.commandRouter.pushConsoleMessage('CorePlayQueue::saveQueue')

    setTimeout(() => {
      fs.writeJson('/data/queue', self.arrayQueue, {spaces: 2}, function (err) {
        if (err) {
          self.commandRouter.logger.info('An error occurred saving queue to disk: ' + err)
        }
      })
    }, 50)
  }

  compareTrackListByUri(trackList1, trackList2) {
    var trackList1String = ''
    var trackList2String = ''

    for (var k in trackList1) {
      if (trackList1[k] && trackList1[k].uri) {
        // We have to replace music-library with mnt to get consistent results
        trackList1String = trackList1String + trackList1[k].uri.replace('music-library', 'mnt')
      }
    }

    for (var h in trackList2) {
      if (trackList2[h] && trackList2[h].uri) {
        trackList2String = trackList2String + trackList2[h].uri.replace('music-library', 'mnt')
      }
    }

    if (trackList1String === trackList2String) {
      return true
    } else {
      return false
    }
  }
}

module.exports = CorePlayQueue
