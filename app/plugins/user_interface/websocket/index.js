'use strict'

var libQ = require('kew')
var semver = require('semver')

module.exports = InterfaceWebUI
function InterfaceWebUI(context) {
  var self = this
  self.context = context
  self.commandRouter = self.context.coreCommand
  self.musicLibrary = self.commandRouter.musicLibrary
  self.logger = self.commandRouter.logger
  self.sendUpdateReady = false
  self.lastPushedBrowseLibraryObject = {}

  /** Init SocketIO listener */
  self.libSocketIO = require('socket.io')(self.context.websocketServer, {
    perMessageDeflate: false,
    maxHttpBufferSize: 1e7,
  })

  self.logger.info('Starting Socket.io Server version ' + require('socket.io/package').version)

  /** On Client Connection, listen for various types of clients requests */
  self.libSocketIO.on('connection', function (connWebSocket) {
    self.logClientConnection(connWebSocket)
    // Closing all modals when clients connect
    connWebSocket.emit('closeAllModals', '')

    connWebSocket.on('initSocket', function (data) {
      self.commandRouter.executeOnPlugin('system_controller', 'volumiodiscovery', 'initSocket', data)
    })

    connWebSocket.on('getDeviceInfo', function () {
      var uuid = self.commandRouter.sharedVars.get('system.uuid')
      var name = self.commandRouter.sharedVars.get('system.name')

      var data = {
        uuid: uuid,
        name: name,
      }
      connWebSocket.emit('pushDeviceInfo', data)
    })

    connWebSocket.on('getState', function () {
      var selfConnWebSocket = this
      var state = self.commandRouter.volumioGetState()
      return self.pushState(state, selfConnWebSocket)
    })

    connWebSocket.on('getQueue', function () {
      var selfConnWebSocket = this
      var queue = self.commandRouter.volumioGetQueue()
      return self.pushQueue(queue, selfConnWebSocket)
    })

    connWebSocket.on('removeQueueItem', function (nIndex) {
      return self.commandRouter.volumioRemoveQueueItem.call(self.commandRouter, nIndex)
    })

    connWebSocket.on('addQueueUids', function (arrayUids) {
      return self.commandRouter.volumioAddQueueUids.call(self.commandRouter, arrayUids)
    })

    connWebSocket.on('addToQueue', function (data) {
      self.commandRouter.addQueueItems(data).then(function () {
        var item = data.uri
        if (data.title) {
          item = data.title
        } else if (data.album) {
          item = data.album
        }
        self.printToastMessage('success', self.commandRouter.getI18nString('COMMON.ADD_QUEUE_TITLE'), item)
      })
    })

    connWebSocket.on('playNext', function (data) {
      return self.commandRouter.playNext(data)
    })

    connWebSocket.on('insertAfterCurrent', function (data) {
      return self.commandRouter.insertAfterCurrent(data)
    })

    connWebSocket.on('replaceAndPlay', function (data) {
      return self.commandRouter.replaceAndPlay(data)
    })

    connWebSocket.on('replaceAndPlayCue', function (data) {
      var timeStart = Date.now()

      if (data.service == undefined || data.service == 'mpd') {
        var uri = data.uri
        var arr = uri.split('/')
        arr.shift()
        var str = arr.join('/')
      } else str = data.uri

      self
        .logStart('Client requests Volumio Clear Queue')
        .then(self.commandRouter.volumioClearQueue.bind(self.commandRouter))
        .then(function () {
          self.commandRouter.executeOnPlugin('music_service', 'mpd', 'addPlayCue', {
            uri: str,
            number: data.number,
          })
        })
        .fail(self.pushError.bind(self))
        .done(function () {
          return self.logDone(timeStart)
        })
    })

    connWebSocket.on('addPlay', function (data) {
      self.commandRouter.preLoadItemsStop()
      return self.commandRouter.addPlay(data)
    })

    connWebSocket.on('playItemsList', function (data) {
      self.commandRouter.preLoadItemsStop()
      return self.commandRouter.playItemsList(data)
    })

    connWebSocket.on('addPlayCue', function (data) {
      self.commandRouter.preLoadItemsStop()
      if (data.service == undefined || data.service == 'mpd') {
        var uri = data.uri
        var arr = uri.split('/')
        arr.shift()
        var str = arr.join('/')
      } else str = data.uri

      self
        .logStart('Client requests add and Play Volumio CUE entry')
        .then(function () {
          return self.commandRouter.executeOnPlugin('music_service', 'mpd', 'addPlayCue', {
            uri: str,
            number: data.number,
          })
        })
        .fail(self.pushError.bind(self))
        .done(function () {
          return self.commandRouter.pushToastMessage('success', self.commandRouter.getI18nString('COMMON.PLAY'), str)
        })
    })

    connWebSocket.on('removeFromQueue', function (positionN) {
      return self.commandRouter.volumioRemoveQueueItem(positionN)
    })

    connWebSocket.on('seek', function (position) {
      return self.commandRouter.volumioSeek(position)
    })

    connWebSocket.on('getLibraryListing', function (objParams) {
      var selfConnWebSocket = this

      var timeStart = Date.now()
      self
        .logStart('Client requests get library listing')
        .then(function () {
          return self.commandRouter.volumioGetLibraryListing.call(self.commandRouter, objParams.uid, objParams.options)
        })
        .then(function (objBrowseData) {
          if (objBrowseData) {
            return self.pushLibraryListing.call(self, objBrowseData, selfConnWebSocket)
          }
        })
        .fail(self.pushError.bind(self))
        .done(function () {
          return self.logDone(timeStart)
        })
    })

    connWebSocket.on('getLibraryFilters', function (sUid) {
      var selfConnWebSocket = this
      var timeStart = Date.now()
      self
        .logStart('Client requests get library index')
        .then(function () {
          return self.commandRouter.volumioGetLibraryFilters.call(self.commandRouter, sUid)
        })
        .then(function (objBrowseData) {
          if (objBrowseData) {
            return self.pushLibraryFilters.call(self, objBrowseData, selfConnWebSocket)
          }
        })
        .fail(self.pushError.bind(self))
        .done(function () {
          return self.logDone(timeStart)
        })
    })

    connWebSocket.on('getPlaylistIndex', function (sUid) {
      var selfConnWebSocket = this
      var timeStart = Date.now()
      self
        .logStart('Client requests get playlist index')
        .then(function () {
          return self.commandRouter.volumioGetPlaylistIndex.call(self.commandRouter, sUid)
        })
        .then(function (objBrowseData) {
          if (objBrowseData) {
            return self.pushPlaylistIndex.call(self, objBrowseData, selfConnWebSocket)
          }
        })
        .fail(self.pushError.bind(self))
        .done(function () {
          return self.logDone(timeStart)
        })
    })

    connWebSocket.on('play', function (N) {
      if (N == null) {
        return self.commandRouter.volumioPlay()
      } else if (N.value != undefined) {
        return self.commandRouter.volumioPlay(N.value)
      }
    })

    connWebSocket.on('volatilePlay', function (N) {
      if (N == null) {
        return self.commandRouter.volumioVolatilePlay()
      } else if (N.value != undefined) {
        return self.commandRouter.volumioVolatilePlay(N.value)
      }
    })

    connWebSocket.on('pause', function () {
      return self.commandRouter.volumioPause()
    })

    connWebSocket.on('toggle', function () {
      return self.commandRouter.volumioToggle()
    })

    connWebSocket.on('stop', function () {
      return self.commandRouter.volumioStop()
    })

    connWebSocket.on('clearQueue', function () {
      return self.commandRouter.volumioClearQueue()
    })

    connWebSocket.on('prev', function () {
      return self.commandRouter.volumioPrevious()
    })

    connWebSocket.on('next', function () {
      self.commandRouter.volumioNext()
    })

    connWebSocket.on('setRandom', function (data) {
      return self.commandRouter.volumioRandom(data.value)
    })

    connWebSocket.on('setRepeat', function (data) {
      return self.commandRouter.volumioRepeat(data.value, data.repeatSingle)
    })

    connWebSocket.on('skipBackwards', function (data) {
      return self.commandRouter.volumioSkipBackwards(data)
    })

    connWebSocket.on('skipForward', function (data) {
      return self.commandRouter.volumioSkipForward(data)
    })

    connWebSocket.on('serviceUpdateTracklist', function (sService) {
      return self.commandRouter.serviceUpdateTracklist(sService)
    })

    connWebSocket.on('updateAllMetadata', function () {
      return self.commandRouter.updateAllMetadata()
    })

    connWebSocket.on('volume', function (value) {
      return self.commandRouter.volumiosetvolume(value)
    })

    connWebSocket.on('mute', function () {
      return self.commandRouter.volumiosetvolume('mute')
    })

    connWebSocket.on('unmute', function () {
      return self.commandRouter.volumiosetvolume('unmute')
    })

    connWebSocket.on('importServicePlaylists', function () {
      self.commandRouter.volumioImportServicePlaylists()
    })

    connWebSocket.on('getMenuItems', function () {
      var selfConnWebSocket = this
      var menuItems = self.commandRouter.getMenuItems()
      menuItems.then(function (menu) {
        selfConnWebSocket.emit('pushMenuItems', menu)
      })
    })

    connWebSocket.on('callMethod', function (dataJson) {
      try {
        var category = dataJson.endpoint.substring(0, dataJson.endpoint.indexOf('/'))
        var name = dataJson.endpoint.substring(dataJson.endpoint.indexOf('/') + 1)

        self.logger.info('CALLMETHOD: ' + category + ' ' + name + ' ' + dataJson.method + ' ' + dataJson.data)
        var promise = self.commandRouter.executeOnPlugin(category, name, dataJson.method, dataJson.data)
        if (promise != undefined) {
          connWebSocket.emit(promise.message, promise.payload)
        }
      } catch (e) {
        self.logger.error('Failed callmethod call: ' + e)
      }
    })

    connWebSocket.on('getUiConfig', function (data) {
      var selfConnWebSocket = this
      var splitted = data.page.split('/')
      var response
      if (splitted.length == 2) {
        response = self.commandRouter.getUIConfigOnPlugin(splitted[0], splitted[1], {})
        response.then(function (config) {
          selfConnWebSocket.emit('pushUiConfig', config)
        })
      } else if (splitted.length == 3) {
        selfConnWebSocket.emit('pushUiConfig', {page: {label: ''}, sections: [{coreSection: splitted[2]}]})
      } else {
        response = self.commandRouter.getUIConfigOnPlugin('system_controller', splitted[0], {})
        response.then(function (config) {
          selfConnWebSocket.emit('pushUiConfig', config)
        })
      }
    })

    connWebSocket.on('getDSPUiConfig', function () {
      var selfConnWebSocket = this
      var response = self.commandRouter.getUIConfigOnPlugin('audio_interface', 'fusiondsp', {})
      response.then(function (config) {
        selfConnWebSocket.emit('pushDSPUiConfig', config)
      })
    })

    connWebSocket.on('getMultiRoomDevices', function () {
      self.pushMultiroom(this)
    })

    connWebSocket.on('getBrowseSources', function (date) {
      var selfConnWebSocket = this
      var response = self.commandRouter.volumioGetVisibleBrowseSources()
      selfConnWebSocket.emit('pushBrowseSources', response)
    })

    connWebSocket.on('browseLibrary', function (data) {
      var selfConnWebSocket = this
      var curUri = data.uri
      var response = self.musicLibrary.executeBrowseSource(curUri)
      if (response != undefined) {
        response
          .then(function (result) {
            if (data.ref) {
              result.ref = data.ref
            }
            self.lastPushedBrowseLibraryObject = result
            selfConnWebSocket.emit('pushBrowseLibrary', result)
            if (result.navigation != undefined && result.navigation.lists != undefined) {
              result.navigation.lists.forEach((list) => {
                if (list.items != undefined)
                  try {
                    setTimeout(function () {
                      self.commandRouter.preLoadItems(list.items)
                    }, 50)
                  } catch (error) {
                    self.logger.error('Preload failed: ' + error)
                  }
              })
            }
          })
          .fail(function (e) {
            if (e && e.errorMessage) {
              self.printToastMessage(
                'error',
                self.commandRouter.getI18nString('COMMON.NO_RESULTS') + ': ' + e.errorMessage
              )
            } else {
              self.printToastMessage(
                'error',
                self.commandRouter.getI18nString('COMMON.ERROR'),
                self.commandRouter.getI18nString('COMMON.NO_RESULTS')
              )
            }
          })
      }
    })

    connWebSocket.on('getInputSources', function () {
      var selfConnWebSocket = this
      var response = self.musicLibrary.executeBrowseSource('inputs')
      if (response != undefined) {
        response
          .then(function (result) {
            selfConnWebSocket.emit('pushInputSources', result)
          })
          .fail(function () {
            self.printToastMessage(
              'error',
              self.commandRouter.getI18nString('COMMON.ERROR'),
              self.commandRouter.getI18nString('COMMON.NO_RESULTS')
            )
          })
      }
    })

    connWebSocket.on('manageBackup', function (data) {
      self.commandRouter
        .managePlaylists(data)
        .then(self.commandRouter.manageFavourites(data))
        .fail(function () {
          self.printToastMessage('error', 'Backup error', 'An error occurred while managing backups')
        })
    })

    connWebSocket.on('getBackup', function (data) {
      var selfConnWebSocket = this
      var response = self.commandRouter.loadBackup(data)
      if (response != undefined) {
        response
          .then(function (result) {
            selfConnWebSocket.emit('pushBackup', result)
          })
          .fail(function () {
            self.printToastMessage(
              'error',
              self.commandRouter.getI18nString('COMMON.ERROR'),
              'Could not retrieve backup'
            )
          })
      }
    })

    connWebSocket.on('restoreConfig', function () {
      self.commandRouter
        .restorePluginsConf()
        .then(self.commandRouter.restorePluginsConf())
        .fail(function () {
          self.printToastMessage(
            'error',
            self.commandRouter.getI18nString('COMMON.ERROR'),
            'Could not restore configuration'
          )
        })
    })

    connWebSocket.on('search', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.musicLibrary.search(data)
      returnedData.then(function (result) {
        self.lastPushedBrowseLibraryObject = result
        selfConnWebSocket.emit('pushBrowseLibrary', result)
      })
    })

    connWebSocket.on('superSearch', function (data) {
      var selfConnWebSocket = this
      if (connWebSocket.id) {
        data.socketId = connWebSocket.id
      }
      var returnedData = self.musicLibrary.superSearch(data)
      returnedData.then(function (result) {
        self.lastPushedBrowseLibraryObject = result
        selfConnWebSocket.emit('pushBrowseLibrary', result)
      })
    })

    connWebSocket.on('goTo', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.musicLibrary.goto(data)
      if (returnedData) {
        returnedData
          .then(function (result) {
            self.lastPushedBrowseLibraryObject = result
            selfConnWebSocket.emit('pushBrowseLibrary', result)
          })
          .fail(function () {
            // No goto method available
          })
      }
    })

    connWebSocket.on('GetTrackInfo', function (data) {
      var selfConnWebSocket = this
      selfConnWebSocket.emit('pushGetTrackInfo', data)
    })

    connWebSocket.on('addWebRadio', function (data) {
      var selfConnWebSocket = this
      var response = self.commandRouter.executeOnPlugin('music_service', 'webradio', 'addMyWebRadio', data)
      if (response != undefined) {
        response
          .then(function (result) {
            selfConnWebSocket.emit('pushAddWebRadio', result)
          })
          .fail(function () {
            self.printToastMessage('error', 'Search error', 'An error occurred while Searching')
          })
      }
    })

    connWebSocket.on('removeWebRadio', function (data) {
      var selfConnWebSocket = this
      var response = self.commandRouter.executeOnPlugin('music_service', 'webradio', 'removeMyWebRadio', data)
      if (response != undefined) {
        response
          .then(function () {
            var response2 = self.musicLibrary.executeBrowseSource('radio/myWebRadio')
            if (response2 != undefined) {
              response2
                .then(function (result2) {
                  self.lastPushedBrowseLibraryObject = result2
                  selfConnWebSocket.emit('pushBrowseLibrary', result2)
                })
                .fail(function () {
                  self.printToastMessage(
                    'error',
                    self.commandRouter.getI18nString('COMMON.ERROR'),
                    self.commandRouter.getI18nString('COMMON.REMOVE_FAIL')
                  )
                })
            }
          })
          .fail(function () {
            self.printToastMessage(
              'error',
              self.commandRouter.getI18nString('COMMON.ERROR'),
              self.commandRouter.getI18nString('COMMON.REMOVE_FAIL')
            )
          })
      }
    })

    connWebSocket.on('getPlaylistContent', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.playListManager.getPlaylistContent(data.name)
      returnedData.then(function (retData) {
        selfConnWebSocket.emit('pushPlaylistContent', {name: data.name, lists: [retData]})
      })
    })

    connWebSocket.on('createPlaylist', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.playListManager.createPlaylist(data.name)
      returnedData.then(function (data) {
        selfConnWebSocket.emit('pushCreatePlaylist', data)
        /* Check if creation was succesful and push new content, on failure data would be same */
        if (data.success === true) {
          self.commandRouter.playListManager
            .listPlaylist()
            .then((data) => selfConnWebSocket.emit('pushListPlaylist', data))
        }
      })
    })

    connWebSocket.on('deletePlaylist', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.playListManager.deletePlaylist(data.name)
      returnedData.then(function (data) {
        selfConnWebSocket.emit('pushListPlaylist', data)
        var response = self.musicLibrary.executeBrowseSource('playlists')
        if (response != undefined) {
          response
            .then(function (result) {
              self.lastPushedBrowseLibraryObject = result
              selfConnWebSocket.emit('pushBrowseLibrary', result)
            })
            .fail(function () {
              self.printToastMessage(
                'error',
                self.commandRouter.getI18nString('COMMON.ERROR'),
                self.commandRouter.getI18nString('COMMON.REMOVE_FAIL')
              )
            })
        }
      })
    })

    connWebSocket.on('listPlaylist', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.playListManager.listPlaylist()
      returnedData.then(function (data) {
        selfConnWebSocket.emit('pushListPlaylist', data)
      })
    })

    connWebSocket.on('addToPlaylist', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.playListManager.addToPlaylist(
        data.name,
        data.service,
        data.uri,
        data.albumTitle
      )
      returnedData.then(function (data) {
        var returnedListData = self.commandRouter.playListManager.listPlaylist()
        returnedListData.then(function (listdata) {
          selfConnWebSocket.emit('pushListPlaylist', listdata)
        })
        selfConnWebSocket.emit('pushAddToPlaylist', data)
      })
    })

    connWebSocket.on('removeFromPlaylist', function (data) {
      var selfConnWebSocket = this
      var playlistname = data.name
      var returnedData = self.commandRouter.playListManager.removeFromPlaylist(
        data.name,
        data.service || 'mpd',
        data.uri
      )
      returnedData.then(function (name) {
        var response = self.musicLibrary.executeBrowseSource('playlists/' + playlistname)
        if (response != undefined) {
          response
            .then(function (result) {
              self.lastPushedBrowseLibraryObject = result
              selfConnWebSocket.emit('pushBrowseLibrary', result)
            })
            .fail(function () {
              self.printToastMessage(
                'error',
                self.commandRouter.getI18nString('COMMON.ERROR'),
                self.commandRouter.getI18nString('COMMON.REMOVE_FAIL')
              )
            })
        }
      })
    })

    connWebSocket.on('playPlaylist', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.playPlaylist(data.name)
      returnedData.then(function (data) {
        selfConnWebSocket.emit('pushPlayPlaylist', data)
      })
    })

    connWebSocket.on('enqueue', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.playListManager.enqueue(data.name)
      returnedData.then(function (data) {
        selfConnWebSocket.emit('pushEnqueue', data)
      })
    })

    connWebSocket.on('addToFavourites', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.playListManager.addToFavourites(data)
      returnedData
        .then(function (data) {
          if (data !== undefined) {
            selfConnWebSocket.emit('urifavourites', data)
          }
        })
        .fail(function () {
          self.printToastMessage(
            'error',
            self.commandRouter.getI18nString('COMMON.ERROR'),
            self.commandRouter.getI18nString('PLAYLIST.ADDED_TO_FAVOURITES')
          )
        })
    })

    connWebSocket.on('removeFromFavourites', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.playListManager.removeFromFavourites(data.name, data.service, data.uri)
      returnedData.then(function () {
        if (data.service === 'shoutcast') {
          response = self.commandRouter.executeOnPlugin('music_service', 'shoutcast', 'listRadioFavourites')
          if (response != undefined) {
            response
              .then(function (result) {
                self.lastPushedBrowseLibraryObject = result
                selfConnWebSocket.emit('pushBrowseLibrary', result)
              })
              .fail(function () {
                self.printToastMessage(
                  'error',
                  self.commandRouter.getI18nString('COMMON.ERROR'),
                  self.commandRouter.getI18nString('COMMON.REMOVE_FAIL')
                )
              })
          }
        } else if (data.service === 'streaming_services') {
          setTimeout(() => {
            var uri = data.uri.substring(0, data.uri.lastIndexOf('/'))
            response = self.musicLibrary.executeBrowseSource(uri)
            if (response != undefined) {
              response
                .then(function (result) {
                  self.lastPushedBrowseLibraryObject = result
                  selfConnWebSocket.emit('pushBrowseLibrary', result)
                })
                .fail(function () {
                  self.printToastMessage(
                    'error',
                    self.commandRouter.getI18nString('COMMON.ERROR'),
                    self.commandRouter.getI18nString('COMMON.REMOVE_FAIL')
                  )
                })
            }
          }, 600)
        } else {
          var response = self.commandRouter.playListManager.listFavourites()
          if (response != undefined) {
            response
              .then(function (result) {
                self.lastPushedBrowseLibraryObject = result
                selfConnWebSocket.emit('pushBrowseLibrary', result)
              })
              .fail(function () {
                self.printToastMessage(
                  'error',
                  self.commandRouter.getI18nString('COMMON.ERROR'),
                  self.commandRouter.getI18nString('COMMON.REMOVE_FAIL')
                )
              })
          }
        }
      })
    })

    connWebSocket.on('playFavourites', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.playListManager.playFavourites(data.name)
      returnedData.then(function (data) {
        selfConnWebSocket.emit('pushPlayFavourites', data)
      })
    })

    connWebSocket.on('addToRadioFavourites', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.playListManager.addToRadioFavourites('shoutcast', data.uri)
      returnedData.then(function (data) {
        selfConnWebSocket.emit('pushAddToRadioFavourites', data)
      })
    })

    connWebSocket.on('removeFromRadioFavourites', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.playListManager.removeFromRadioFavourites(data.name, 'shoutcast', data.uri)
      returnedData.then(function (data) {
        selfConnWebSocket.emit('pushRemoveFromRadioFavourites', data)
      })
    })

    connWebSocket.on('playRadioFavourites', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.playListManager.playRadioFavourites()
      returnedData.then(function (data) {
        selfConnWebSocket.emit('pushPlayRadioFavourites', data)
      })
    })

    connWebSocket.on('getSleep', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.executeOnPlugin('miscellanea', 'alarm-clock', 'getSleep', data)
      returnedData.then(function (data) {
        selfConnWebSocket.emit('pushSleep', data)
      })
    })

    connWebSocket.on('setSleep', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.executeOnPlugin('miscellanea', 'alarm-clock', 'setSleep', data)
      returnedData.then(function (data) {
        selfConnWebSocket.emit('pushSleep', data)
      })
    })

    connWebSocket.on('getAlarms', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.executeOnPlugin('miscellanea', 'alarm-clock', 'getAlarms', '')
      returnedData.then(function (data) {
        selfConnWebSocket.emit('pushAlarm', data)
      })
    })

    connWebSocket.on('saveAlarm', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.executeOnPlugin('miscellanea', 'alarm-clock', 'saveAlarm', data)
      returnedData.then(function (data) {
        selfConnWebSocket.emit('pushSleep', data)
      })
    })

    connWebSocket.on('getMultiroom', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.executeOnPlugin('audio_interface', 'multiroom', 'getMultiroom', data)
      if (returnedData != undefined) {
        returnedData.then(function (data) {
          if (data != undefined) {
            selfConnWebSocket.emit('pushMultiroom', data)
          }
        })
      }
    })

    connWebSocket.on('setMultiroom', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.executeOnPlugin('audio_interface', 'multiroom', 'setMultiroom', data)
      returnedData.then(function (data) {
        selfConnWebSocket.emit('pushMultiroom', data)
      })
    })

    connWebSocket.on('writeMultiroom', function (data) {
      self.commandRouter.executeOnPlugin('audio_interface', 'multiroom', 'writeMultiRoom', data)
    })

    connWebSocket.on('receiveMultiroomDeviceUpdate', function (data) {
      self.commandRouter.executeOnPlugin('system_controller', 'volumiodiscovery', 'receiveMultiroomDeviceUpdate', data)
    })

    connWebSocket.on('setAsMultiroomSingle', function (data) {
      self.commandRouter.executeOnPlugin('audio_interface', 'multiroom', 'setSingle', data)
    })
    connWebSocket.on('setAsMultiroomServer', function (data) {
      self.commandRouter.executeOnPlugin('audio_interface', 'multiroom', 'setServer', data)
    })
    connWebSocket.on('setAsMultiroomClient', function (data) {
      self.commandRouter.executeOnPlugin('audio_interface', 'multiroom', 'setClient', data)
    })

    connWebSocket.on('shutdown', function () {
      return self.commandRouter.shutdown()
    })

    connWebSocket.on('standby', function () {
      // console.log('Received Shutdown Command');

      return self.commandRouter.standby()
    })

    connWebSocket.on('reboot', function () {
      return self.commandRouter.reboot()
    })

    connWebSocket.on('fastReboot', function () {
      return self.commandRouter.fastReboot()
    })

    connWebSocket.on('getWirelessNetworks', function () {
      var selfConnWebSocket = this
      var wirelessNetworksCache = self.commandRouter.executeOnPlugin(
        'system_controller',
        'network',
        'getWirelessNetworksScanCache',
        ''
      )
      if (wirelessNetworksCache) {
        selfConnWebSocket.emit('pushWirelessNetworks', wirelessNetworksCache)
      }
      var returnedData = self.commandRouter.executeOnPlugin('system_controller', 'network', 'getWirelessNetworks', '')
      if (returnedData != undefined) {
        returnedData.then(function (data) {
          selfConnWebSocket.emit('pushWirelessNetworks', data)
        })
      } else console.log('Error on returning wireless networks')
    })

    connWebSocket.on('getWirelessNetworksCache', function () {
      var selfConnWebSocket = this
      var wirelessNetworksCache = self.commandRouter.executeOnPlugin(
        'system_controller',
        'network',
        'getWirelessNetworksScanCache',
        ''
      )
      if (wirelessNetworksCache) {
        selfConnWebSocket.emit('pushWirelessNetworksCache', wirelessNetworksCache)
      }
    })

    connWebSocket.on('saveWirelessNetworkSettings', function (data) {
      self.commandRouter.executeOnPlugin('system_controller', 'network', 'saveWirelessNetworkSettings', data)
    })

    connWebSocket.on('getInfoNetwork', function () {
      var selfConnWebSocket = this
      var defer = self.commandRouter.executeOnPlugin('system_controller', 'network', 'getInfoNetwork', '')
      defer
        .then(function (data) {
          selfConnWebSocket.emit('pushInfoNetwork', data)
        })
        .fail(function () {
          selfConnWebSocket.emit('pushInfoNetwork', {status: 'Not Connected', online: 'no'})
        })
    })

    connWebSocket.on('updateCheck', function () {
      var selfConnWebSocket = this
      var checkingMessage = {
        changeLogLink: '',
        description: self.commandRouter.getI18nString('UPDATER.CHECKING_FOR_UPDATES_WAIT'),
        title: self.commandRouter.getI18nString('UPDATER.CHECKING_FOR_UPDATES'),
        updateavailable: false,
      }
      selfConnWebSocket.emit('updateWaitMsg', checkingMessage)
      self.sendUpdateReady = true
      self.commandRouter.broadcastMessage('ClientUpdateCheck', 'search-for-upgrade')
    })

    connWebSocket.on('updateCheckCache', function () {
      var selfConnWebSocket = this
      self.sendUpdateReady = false
      var autoUpdateCheckCloudEnabled = self.commandRouter.executeOnPlugin(
        'system_controller',
        'my_volumio',
        'getAutoUpdateCheckEnabled'
      )
      if (autoUpdateCheckCloudEnabled != undefined) {
        autoUpdateCheckCloudEnabled
          .then(function (result) {
            if (result) {
              var updateMessage = self.commandRouter.executeOnPlugin(
                'system_controller',
                'updater_comm',
                'getUpdateMessageCache'
              )
              selfConnWebSocket.emit('updateReadyCache', updateMessage)
            }
          })
          .fail(function () {})
      }
    })

    connWebSocket.on('ClientUpdateReady', function (message) {
      var updateMessage = JSON.parse(message)
      self.logger.info('Update Ready: ' + JSON.stringify(updateMessage))
      try {
        if (updateMessage && updateMessage.updateavailable === false) {
          updateMessage.title = self.commandRouter.getI18nString('SYSTEM.NO_UPDATE_AVAILABLE')
          updateMessage.description = self.commandRouter.getI18nString('SYSTEM.UPDATE_ALREADY_LATEST_VERSION')
        }
      } catch (e) {
        self.logger.error('Cannot translate update title: ' + e)
      }

      if (updateMessage && updateMessage.updateavailable === true) {
        // Always use a loose parse as Volumio versions aren't properly semver.
        // For example 3.054 isn't valid due to the leading '0'.
        var updateVersion = semver.coerce(updateMessage.title, {loose: true})
        if (updateVersion !== null) {
          var broken = self.commandRouter.pluginManager.listPluginsBrokenByNewVersion(updateVersion.version)
          if (broken.length > 0) {
            updateMessage.description +=
              '<br><p><strong>The following plugins will be broken by this update:</strong></p> ' + broken
          }
        }
      }
      self.commandRouter.executeOnPlugin('system_controller', 'updater_comm', 'setUpdateMessageCache', updateMessage)
      if (self.sendUpdateReady) {
        self.commandRouter.broadcastMessage('updateReady', updateMessage)
      }
      self.sendUpdateReady = false
    })

    connWebSocket.on('update', function (data) {
      var selfConnWebSocket = this
      self.logger.info('Update: ' + data)
      var checking = {
        downloadSpeed: '',
        eta: '5m',
        progress: 1,
        status: self.commandRouter.getI18nString('SYSTEM.CHECKING_SYSTEM_INTEGRITY'),
      }
      selfConnWebSocket.emit('updateProgress', checking)
      var integrityCheck = self.commandRouter.executeOnPlugin(
        'system_controller',
        'updater_comm',
        'checkSystemIntegrity'
      )
      integrityCheck.then((integrity) => {
        if (
          (data.ignoreIntegrityCheck !== undefined && data.ignoreIntegrityCheck) ||
          (integrity && integrity.isSystemOk != undefined && integrity.isSystemOk)
        ) {
          self.commandRouter.executeOnPlugin('system_controller', 'system', 'setTestSystem', false)
          self.commandRouter.broadcastMessage('ClientUpdate', {value: 'now'})
          var started = {
            downloadSpeed: '',
            eta: '5m',
            progress: 1,
            status: self.commandRouter.getI18nString('SYSTEM.STARTING_SOFTWARE_UPDATE'),
          }
          selfConnWebSocket.emit('updateProgress', started)
          self.commandRouter.executeOnPlugin('system_controller', 'updater_comm', 'notifyProgress', '')
        } else {
          self.commandRouter.closeModals()
          var responseData = {
            title: self.commandRouter.getI18nString('SYSTEM.UPDATE_FAILED'),
            message: self.commandRouter.getI18nString('SYSTEM.SYSTEM_INTEGRITY_CHECK_FAILED'),
            size: 'lg',
            buttons: [
              {
                name: self.commandRouter.getI18nString('COMMON.GOT_IT'),
                class: 'btn btn-info ng-scope',
                emit: 'closeModals',
                payload: '',
              },
            ],
          }
          self.commandRouter.broadcastMessage('openModal', responseData)
        }
      })
    })

    connWebSocket.on('deleteUserData', function () {
      self.logger.info('Command Delete User Data Received')

      // Signalling MCU to perform factory reset
      self.commandRouter.executeOnPlugin('music_service', 'inputs', 'setMCUFactoryReset', '')

      // Actually executing Factory Reset
      setTimeout(() => {
        self.commandRouter.executeOnPlugin('system_controller', 'system', 'deleteUserData', '')
      }, 500)
    })

    // NOTE: This is deprecated, we use deleteUserData in place of factory reset now
    connWebSocket.on('factoryReset', function () {
      self.logger.info('Command Factory Reset Received')
      self.commandRouter.broadcastMessage('ClientFactoryReset', {value: 'now'})
    })

    connWebSocket.on('getAutomaticUpdateEnabled', function () {
      var selfConnWebSocket = this
      selfConnWebSocket.emit('pushAutomaticUpdateEnabled', process.env.AUTO_UPDATE_AUTOMATIC_INSTALL === 'true')
    })

    connWebSocket.on('getSystemVersion', function () {
      var selfConnWebSocket = this
      self.logger.info('Received Get System Version')
      var returnedData = self.commandRouter.executeOnPlugin('system_controller', 'system', 'getSystemVersion')

      if (returnedData != undefined) {
        returnedData.then(function (data) {
          if (data != undefined) {
            selfConnWebSocket.emit('pushSystemVersion', data)
          }
        })
      }
    })

    connWebSocket.on('getSystemInfo', function () {
      var selfConnWebSocket = this
      self.logger.info('Received Get System Info')
      var returnedData = self.commandRouter.executeOnPlugin('system_controller', 'system', 'getSystemInfo')
      if (returnedData != undefined) {
        returnedData.then(function (data) {
          if (data != undefined) {
            selfConnWebSocket.emit('pushSystemInfo', data)
          }
        })
      }
    })

    /**
     * Executes the getMyCollectionStats method on the MPD plugin
     */
    connWebSocket.on('getMyCollectionStats', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.executeOnPlugin('music_service', 'mpd', 'getMyCollectionStats', '')
      if (returnedData != undefined) {
        returnedData.then(function (data) {
          selfConnWebSocket.emit('pushMyCollectionStats', data)
        })
      } else console.log('Error on Wireless Scan')
    })

    /**
     * Executes the rescanDb method on the MPD plugin. No response is foreseen
     */
    connWebSocket.on('rescanDb', function () {
      self.commandRouter.executeOnPlugin('music_service', 'mpd', 'rescanDb', '')
    })

    connWebSocket.on('updateDb', function (data) {
      self.commandRouter.executeOnPlugin('music_service', 'mpd', 'updateDb', data)
    })

    /**
     * New share APIs
     */
    connWebSocket.on('addShare', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.executeOnPlugin('system_controller', 'networkfs', 'addShare', data)
      if (returnedData != undefined) {
        returnedData.then(function (datas) {
          selfConnWebSocket.emit(datas.emit, datas.data)
          setTimeout(function () {
            var listdata = self.commandRouter.executeOnPlugin('system_controller', 'networkfs', 'listShares', '')
            if (listdata != undefined) {
              listdata.then(function (datalist) {
                selfConnWebSocket.emit('pushListShares', datalist)
              })
            }
          }, 1000)
        })
      } else self.logger.error('Error on adding share')
    })

    connWebSocket.on('deleteShare', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.executeOnPlugin('system_controller', 'networkfs', 'deleteShare', data)
      if (returnedData != undefined) {
        returnedData.then(function (datas) {
          selfConnWebSocket.emit(datas.emit, datas.data)
          setTimeout(function () {
            var listdata = self.commandRouter.executeOnPlugin('system_controller', 'networkfs', 'listShares', '')
            if (listdata != undefined) {
              listdata.then(function (datalist) {
                selfConnWebSocket.emit('pushListShares', datalist)
              })
            }
          }, 1000)
        })
      } else self.logger.error('Error on deleting share')
    })

    connWebSocket.on('getListShares', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.executeOnPlugin('system_controller', 'networkfs', 'listShares', data)
      if (returnedData != undefined) {
        returnedData.then(function (data) {
          selfConnWebSocket.emit('pushListShares', data)
        })
      } else self.logger.error('Error on deleting share')
    })

    connWebSocket.on('getInfoShare', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.executeOnPlugin('system_controller', 'networkfs', 'infoShare', data)
      if (returnedData != undefined) {
        returnedData.then(function (data) {
          selfConnWebSocket.emit('pushInfoShare', data)
        })
      } else self.logger.error('Error on getting information on share')
    })

    connWebSocket.on('editShare', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.executeOnPlugin('system_controller', 'networkfs', 'editShare', data)
      if (returnedData != undefined) {
        returnedData.then(function (datas) {
          selfConnWebSocket.emit(datas.emit, datas.data)
          setTimeout(function () {
            var listdata = self.commandRouter.executeOnPlugin('system_controller', 'networkfs', 'listShares', '')
            if (listdata != undefined) {
              listdata.then(function (datalist) {
                selfConnWebSocket.emit('pushListShares', datalist)
              })
            }
          }, 1000)
        })
      } else self.logger.error('Error on storing on share')
    })

    connWebSocket.on('listUsbDrives', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.executeOnPlugin('system_controller', 'networkfs', 'listUsbDrives', data)
      if (returnedData != undefined) {
        returnedData.then(function (data) {
          selfConnWebSocket.emit('pushListUsbDrives', data)
        })
      } else self.logger.error('Error on listing USB devices')
    })

    /*
      PLUGIN INSTALLATION METHODS
    */

    /*
      Format expected: tar.gz
      data:   {uri:'http://....../plugin.tar.gz'}
    */
    connWebSocket.on('installPlugin', function (data) {
      var selfConnWebSocket = this
      selfConnWebSocket.emit('closeModals', '')
      if (process.env.WARNING_ON_PLUGIN_INSTALL === 'true' && data.confirm !== true) {
        data.confirm = true
        return selfConnWebSocket.emit('openModal', {
          title: self.commandRouter.getI18nString('PLUGINS.CONFIRM_PLUGIN_INSTALL'),
          message: self.commandRouter.getI18nString('PLUGINS.CONFIRM_PLUGIN_INSTALL_WARNING_MESSAGE') + '?',
          buttons: [
            {
              name: self.commandRouter.getI18nString('COMMON.CANCEL'),
              class: 'btn btn-info',
              emit: 'closeModals',
              payload: '',
            },
            {
              name: self.commandRouter.getI18nString('PLUGINS.INSTALL'),
              class: 'btn btn-warning',
              emit: 'installPlugin',
              payload: data,
            },
          ],
        })
      } else {
        selfConnWebSocket.emit('openInstallerModal', '')
        var returnedData = self.commandRouter.installPlugin(data.url)
        if (returnedData != undefined) {
          returnedData.then(function (data) {
            selfConnWebSocket.emit('pushInstallPlugin', data)
            var installed = self.commandRouter.getInstalledPlugins()
            if (installed != undefined) {
              installed.then(function (installedPLugins) {
                self.broadcastMessage('pushInstalledPlugins', installedPLugins)
              })
            }
            var available = self.commandRouter.getAvailablePlugins()
            if (available != undefined) {
              available.then(function (AvailablePlugins) {
                selfConnWebSocket.emit('pushAvailablePlugins', AvailablePlugins)
              })
            }
          })
        } else {
          self.logger.error('Error on installing plugin')
        }
      }
    })

    connWebSocket.on('updatePlugin', function (data) {
      var selfConnWebSocket = this
      selfConnWebSocket.emit('openInstallerModal', '')
      var returnedData = self.commandRouter.updatePlugin(data)
      if (returnedData != undefined) {
        returnedData.then(function (data) {
          selfConnWebSocket.emit('pushInstallPlugin', data)
          var installed = self.commandRouter.getInstalledPlugins()
          if (installed != undefined) {
            installed.then(function (installedPLugins) {
              self.logger.info(JSON.stringify(installedPLugins))
              selfConnWebSocket.emit('pushInstalledPlugins', installedPLugins)
            })
          }
          var available = self.commandRouter.getAvailablePlugins()
          if (available != undefined) {
            available.then(function (AvailablePlugins) {
              selfConnWebSocket.emit('pushAvailablePlugins', AvailablePlugins)
            })
          }
        })
      } else self.logger.error('Error on installing plugin')
    })

    connWebSocket.on('unInstallPlugin', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.unInstallPlugin(data)
      if (returnedData != undefined) {
        returnedData.then(function (data) {
          selfConnWebSocket.emit('pushUnInstallPlugin', data)
          var installed = self.commandRouter.getInstalledPlugins()
          if (installed != undefined) {
            installed.then(function (installedPLugins) {
              self.logger.info(JSON.stringify(installedPLugins))
              selfConnWebSocket.emit('pushInstalledPlugins', installedPLugins)
            })
          }
          var available = self.commandRouter.getAvailablePlugins()
          if (available != undefined) {
            available.then(function (AvailablePlugins) {
              selfConnWebSocket.emit('pushAvailablePlugins', AvailablePlugins)
            })
          }
        })
      } else self.logger.error('Error on installing plugin')
    })

    connWebSocket.on('enablePlugin', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.enablePlugin(data)
      if (returnedData != undefined) {
        returnedData.then(function (data) {
          selfConnWebSocket.emit('pushEnablePlugin', data)
          var installed = self.commandRouter.getInstalledPlugins()
          if (installed != undefined) {
            installed.then(function (installedPLugins) {
              self.logger.info(JSON.stringify(installedPLugins))
              selfConnWebSocket.emit('pushInstalledPlugins', installedPLugins)
            })
          }
        })
      } else self.logger.error('Error on installing plugin')
    })

    connWebSocket.on('disablePlugin', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.disablePlugin(data)
      if (returnedData != undefined) {
        returnedData.then(function (data) {
          selfConnWebSocket.emit('pushDisablePlugin', data)
          var installed = self.commandRouter.getInstalledPlugins()
          if (installed != undefined) {
            installed.then(function (installedPLugins) {
              self.logger.info(JSON.stringify(installedPLugins))
              selfConnWebSocket.emit('pushInstalledPlugins', installedPLugins)
            })
          }
        })
      } else self.logger.error('Error on disabling plugin')
    })

    connWebSocket.on('modifyPluginStatus', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.modifyPluginStatus(data)
      if (returnedData != undefined) {
        returnedData.then(function (data) {
          selfConnWebSocket.emit('pushModifyPluginStatus', data)
          var installed = self.commandRouter.getInstalledPlugins()
          if (installed != undefined) {
            installed.then(function (installedPLugins) {
              self.logger.info(JSON.stringify(installedPLugins))
              selfConnWebSocket.emit('pushInstalledPlugins', installedPLugins)
            })
          }
        })
      } else self.logger.error('Error on disabling plugin')
    })

    connWebSocket.on('getInstalledPlugins', function (pippo) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.getInstalledPlugins()
      if (returnedData != undefined) {
        returnedData.then(function (installedPLugins) {
          selfConnWebSocket.emit('pushInstalledPlugins', installedPLugins)
        })
      } else self.logger.error('Error on getting installed plugins')
    })

    connWebSocket.on('getAvailablePlugins', function (pippo) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.getAvailablePlugins()
      if (returnedData != undefined) {
        returnedData.then(function (AvailablePlugins) {
          if (AvailablePlugins.NotAuthorized) {
            var modalButtons = [
              {
                name: self.commandRouter.getI18nString('COMMON.CLOSE'),
                class: 'btn btn-warning',
                emit: 'closeModals',
                payload: '',
              },
              {
                name: self.commandRouter.getI18nString('COMMON.LOGIN'),
                class: 'btn btn-info',
                state: 'myvolumio.access',
                payload: '',
              },
            ]
            var modalContent = {
              title: self.commandRouter.getI18nString('PLUGINS.PLUGIN_LOGIN'),
              message: self.commandRouter.getI18nString('PLUGINS.PLUGIN_LOGIN_MESSAGE'),
              buttons: modalButtons,
            }
            selfConnWebSocket.emit('openModal', modalContent)
          } else {
            selfConnWebSocket.emit('pushAvailablePlugins', AvailablePlugins)
          }
        })
      } else self.logger.error('Error on getting Available plugins')
    })

    connWebSocket.on('getPluginDetails', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.getPluginDetails(data)
      if (returnedData != undefined) {
        returnedData.then(function (Details) {
          selfConnWebSocket.emit('openModal', Details)
        })
      } else self.logger.error('Error on getting Plugin Details')
    })

    connWebSocket.on('pluginManager', function (data) {
      var selfConnWebSocket = this
      if (data.action === 'getUiConfig') {
        return self.commandRouter.executeOnPlugin(data.category, data.name, 'getUiConfig')
      } else if (data.action === 'setUiConfig') {
        return self.commandRouter.executeOnPlugin(data.category, data.name, 'setUiConfig', data)
      } else if (data.action === 'enable') {
        var returnedData = self.commandRouter.enableAndStartPlugin(data.category, data.name)
        returnedData.then(function (data) {
          var installed = self.commandRouter.getInstalledPlugins()
          if (installed != undefined) {
            installed.then(function (installedPLugins) {
              selfConnWebSocket.emit('pushInstalledPlugins', installedPLugins)
            })
          }
        })
      } else if (data.action === 'disable') {
        var returnedData = self.commandRouter.disableAndStopPlugin(data.category, data.name)
        if (returnedData != undefined) {
          returnedData.then(function (data) {
            selfConnWebSocket.emit('pushDisablePlugin', data)
            var installed = self.commandRouter.getInstalledPlugins()
            if (installed != undefined) {
              installed.then(function (installedPLugins) {
                selfConnWebSocket.emit('pushInstalledPlugins', installedPLugins)
              })
            }
          })
        }
      }
    })

    connWebSocket.on('preUninstallPlugin', function (data) {
      this.emit('openModal', {
        title: self.commandRouter.getI18nString('PLUGINS.CONFIRM_PLUGIN_UNINSTALL'),
        message: self.commandRouter.getI18nString('PLUGINS.CONFIRM_PLUGIN_UNINSTALL_MESSAGE') + '?',
        buttons: [
          {name: self.commandRouter.getI18nString('COMMON.CANCEL'), class: 'btn btn-info'},
          {
            name: self.commandRouter.getI18nString('PLUGINS.UNINSTALL'),
            class: 'btn btn-warning',
            emit: 'unInstallPlugin',
            payload: {category: data.category, name: data.name},
          },
        ],
      })
    })

    // ======================== AUDIO OUTPUTS ==========================

    connWebSocket.on('getAudioOutputs', function (data) {
      var selfConnWebSocket = this
      var outputs = self.commandRouter.getAudioOutputs()
      if (outputs != undefined) {
        selfConnWebSocket.emit('pushAudioOutputs', outputs)
      }
    })

    connWebSocket.on('enableAudioOutput', function (data) {
      self.commandRouter.enableAudioOutput(data)
    })

    connWebSocket.on('disableAudioOutput', function (data) {
      self.commandRouter.disableAudioOutput(data)
    })

    connWebSocket.on('setAudioOutputVolume', function (data) {
      self.commandRouter.setAudioOutputVolume(data)
    })

    connWebSocket.on('audioOutputPlay', function (data) {
      self.commandRouter.audioOutputPlay(data)
    })

    connWebSocket.on('audioOutputPause', function (data) {
      self.commandRouter.audioOutputPause(data)
    })

    connWebSocket.on('saveQueueToPlaylist', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.volumioSaveQueueToPlaylist(data.name)
      if (returnedData != undefined) {
        returnedData.then(function (data) {
          selfConnWebSocket.emit('pushSaveQueueToPlaylist', data)
        })
      } else self.logger.error('Error on saving queue to playlist')
    })

    connWebSocket.on('setConsume', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.volumioConsume(data.value)
      if (returnedData != undefined) {
        returnedData.then(function (data) {
          selfConnWebSocket.emit('pushSetConsume', data)
        })
      } else self.logger.error('Error on setting consume mode')
    })

    connWebSocket.on('moveQueue', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.volumioMoveQueue(data.from, data.to)
      if (returnedData != undefined) {
        returnedData.then(function (data) {
          selfConnWebSocket.emit('pushQueue', data)
        })
      } else self.logger.error('Error on moving item in list')
    })

    connWebSocket.on('getUiSettings', function () {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.executeOnPlugin('miscellanea', 'appearance', 'getUiSettings', '')
      if (returnedData != undefined) {
        returnedData.then(function (data) {
          selfConnWebSocket.emit('pushUiSettings', data)
        })
      } else self.logger.error('Cannot get UI Settings')
    })

    connWebSocket.on('getOnboardingWizard', function () {
      var selfConnWebSocket = this

      var returnedData = self.commandRouter.executeOnPlugin('miscellanea', 'wizard', 'getOnboardingWizard', '')
      if (returnedData != undefined) {
        returnedData.then(function (data) {
          if (data) {
            selfConnWebSocket.emit('firstOnboardingWizard', data)
          } else {
            self.logger.error('No data to send for onboarding wizard')
          }
        })
      } else self.logger.error('Cannot get onboarding wizard')
    })

    connWebSocket.on('setOnboardingWizardFalse', function () {
      self.commandRouter.executeOnPlugin('miscellanea', 'wizard', 'setOnboardingWizardFalse', '')
      self.commandRouter.broadcastMessage('closeOnboardingWizard', '')
    })

    connWebSocket.on('getBackgrounds', function () {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.executeOnPlugin('miscellanea', 'appearance', 'getBackgrounds', '')
      if (returnedData != undefined) {
        returnedData.then(function (data) {
          selfConnWebSocket.emit('pushBackgrounds', data)
        })
      } else self.logger.error('Cannot get UI Settings')
    })

    connWebSocket.on('setBackgrounds', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.executeOnPlugin('miscellanea', 'appearance', 'setBackgrounds', data)
      if (returnedData != undefined) {
        var backgrounds = self.commandRouter.executeOnPlugin('miscellanea', 'appearance', 'getBackgrounds', '')
        if (backgrounds != undefined) {
          backgrounds.then(function (backgroundsdata) {
            selfConnWebSocket.emit('pushBackgrounds', backgroundsdata)
            var returnedData2 = self.commandRouter.executeOnPlugin('miscellanea', 'appearance', 'getUiSettings', '')
            if (returnedData2 != undefined) {
              returnedData2.then(function (data2) {
                selfConnWebSocket.emit('pushUiSettings', data2)
              })
            }
          })
        }
      } else self.logger.error('Cannot set UI Settings')
    })

    connWebSocket.on('deleteBackground', function (data) {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.executeOnPlugin('miscellanea', 'appearance', 'deleteBackgrounds', data)
      if (returnedData != undefined) {
        returnedData.then(function (backgroundsdata) {
          selfConnWebSocket.emit('pushBackgrounds', backgroundsdata)
        })
      } else self.logger.error('Cannot Delete Image')
    })

    connWebSocket.on('regenerateThumbnails', function (data) {
      var returnedData = self.commandRouter.executeOnPlugin('miscellanea', 'appearance', 'generateThumbnails', '')
      if (returnedData != undefined) {
        var backgrounds = self.commandRouter.executeOnPlugin('miscellanea', 'appearance', 'getBackgrounds', '')
        if (backgrounds != undefined) {
          backgrounds.then(function (backgroundsdata) {
            setTimeout(function () {
              self.libSocketIO.sockets.emit('pushBackgrounds', backgroundsdata)
            }, 1000)
          })
        }
      } else self.logger.error('Cannot Regenerate Thumbnails')
    })

    connWebSocket.on('getNetworkSharesDiscovery', function () {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.executeOnPlugin('system_controller', 'networkfs', 'discoverShares', '')
      if (returnedData != undefined) {
        returnedData.then(function (data) {
          selfConnWebSocket.emit('pushNetworkSharesDiscovery', data)
        })
      }
    })

    connWebSocket.on('getWizard', function () {
      var selfConnWebSocket = this
      var showWizard = self.commandRouter.executeOnPlugin('miscellanea', 'wizard', 'getShowWizard', '')
      selfConnWebSocket.emit('pushWizard', {openWizard: showWizard})
    })

    connWebSocket.on('runFirstConfigWizard', function () {
      var selfConnWebSocket = this
      self.commandRouter.executeOnPlugin('miscellanea', 'wizard', 'openWizard', '')
      selfConnWebSocket.emit('pushWizard', {openWizard: true})
    })

    connWebSocket.on('getWizardSteps', function () {
      var selfConnWebSocket = this
      var wizardSteps = self.commandRouter.executeOnPlugin('miscellanea', 'wizard', 'getWizardSteps', '')
      selfConnWebSocket.emit('pushWizardSteps', wizardSteps)
    })

    connWebSocket.on('setWizardAction', function (data) {
      return self.commandRouter.executeOnPlugin('miscellanea', 'wizard', 'setWizardAction', data)
    })

    connWebSocket.on('getWizardUiConfig', function (data) {
      var selfConnWebSocket = this
      var wizardConfig = self.commandRouter.executeOnPlugin('miscellanea', 'wizard', 'getWizardConfig', data)
      if (wizardConfig != undefined) {
        wizardConfig.then(function (data) {
          selfConnWebSocket.emit('pushUiConfig', data)
        })
      }
    })

    connWebSocket.on('getAvailableLanguages', function () {
      var selfConnWebSocket = this
      var languages = self.commandRouter.executeOnPlugin('miscellanea', 'appearance', 'getAvailableLanguages', '')
      if (languages != undefined) {
        languages.then(function (data) {
          selfConnWebSocket.emit('pushAvailableLanguages', data)
        })
      }
    })

    connWebSocket.on('setLanguage', function (data) {
      var disallowReload = false
      var value = data.defaultLanguage.code
      var label = data.defaultLanguage.language
      if (data.disallowReload != undefined) {
        disallowReload = data.disallowReload
      }
      var languagedata = {language: {value: value, label: label}, disallowReload: disallowReload}
      self.commandRouter.executeOnPlugin('miscellanea', 'appearance', 'setLanguage', languagedata)
    })

    connWebSocket.on('getAvailableTimezones', function () {
      var selfConnWebSocket = this
      var data = self.commandRouter.executeOnPlugin('system_controller', 'system', 'getAvailableTimezones')
      selfConnWebSocket.emit('pushAvailableTimezones', data)
    })

    connWebSocket.on('getCurrentTimezone', function () {
      var selfConnWebSocket = this
      var data = self.commandRouter.executeOnPlugin('system_controller', 'system', 'getCurrentTimezone')
      selfConnWebSocket.emit('pushCurrentTimezone', data)
    })

    connWebSocket.on('setTimezone', function (data) {
      self.commandRouter.executeOnPlugin('system_controller', 'system', 'setTimezone', data)
    })

    connWebSocket.on('getDeviceName', function () {
      var selfConnWebSocket = this
      var name = self.commandRouter.sharedVars.get('system.name')
      selfConnWebSocket.emit('pushDeviceName', {name: name})
    })

    connWebSocket.on('setDeviceName', function (data) {
      var selfConnWebSocket = this
      if (data && data.name && data.name.length) {
        var options = {player_name: data.name}
        var name = self.commandRouter.executeOnPlugin('system_controller', 'system', 'saveGeneralSettings', options)
      }
    })

    connWebSocket.on('getOutputDevices', function () {
      var selfConnWebSocket = this
      var audiolist = self.commandRouter.executeOnPlugin('audio_interface', 'alsa_controller', 'getAudioDevices', '')
      if (audiolist != undefined) {
        audiolist.then(function (data) {
          selfConnWebSocket.emit('pushOutputDevices', data)
        })
      }
    })

    connWebSocket.on('getExperienceAdvancedSettings', function () {
      var selfConnWebSocket = this
      var experienceAdvancedSettings = self.commandRouter.getExperienceAdvancedSettings()
      selfConnWebSocket.emit('pushExperienceAdvancedSettings', experienceAdvancedSettings)
    })

    connWebSocket.on('setExperienceAdvancedSettings', function (data) {
      return self.commandRouter.executeOnPlugin('system_controller', 'system', 'setExperienceAdvancedSettings', data)
    })

    connWebSocket.on('setOutputDevices', function (data) {
      data.disallowPush = true
      return self.commandRouter.executeOnPlugin('audio_interface', 'alsa_controller', 'saveAlsaOptions', data)
    })

    connWebSocket.on('getDonePage', function () {
      var selfConnWebSocket = this
      var donation = self.commandRouter.executeOnPlugin('miscellanea', 'wizard', 'getDonation', '')
      var contributionsarray = self.commandRouter.executeOnPlugin('miscellanea', 'wizard', 'getDonationsArray', '')
      var lastStepMessage = self.commandRouter.executeOnPlugin('miscellanea', 'wizard', 'getDoneMessage', '')
      var laststep = {
        congratulations: lastStepMessage.congratulations,
        title: lastStepMessage.title,
        message: lastStepMessage.message,
        donation: donation,
        donationAmount: contributionsarray,
      }
      selfConnWebSocket.emit('pushDonePage', laststep)
    })

    connWebSocket.on('setDeviceActivationCode', function (data) {
      var selfConnWebSocket = this
      var codeCheck = self.commandRouter.executeOnPlugin('system_controller', 'my_volumio', 'checkDeviceCode', data)
      if (codeCheck != undefined) {
        codeCheck.then(function (data) {
          selfConnWebSocket.emit('pushDeviceActivationCodeResult', data)
        })
      }
    })

    connWebSocket.on('getDeviceActivationStatus', function () {
      var selfConnWebSocket = this
      var codeCheck = self.commandRouter.executeOnPlugin(
        'system_controller',
        'my_volumio',
        'getDeviceActivationStatus',
        ''
      )
      if (codeCheck != undefined) {
        codeCheck.then(function (data) {
          selfConnWebSocket.emit('pushDeviceActivationStatus', data)
        })
      }
    })

    connWebSocket.on('checkPassword', function (data) {
      var selfConnWebSocket = this
      var check = self.commandRouter.executeOnPlugin('system_controller', 'system', 'checkPassword', data)
      if (check != undefined) {
        check.then(function (data) {
          selfConnWebSocket.emit('checkPassword', data)
        })
      }
    })

    connWebSocket.on('connectWirelessNetworkWizard', function (data) {
      var selfConnWebSocket = this
      var connectWifiWizard = self.commandRouter.executeOnPlugin(
        'miscellanea',
        'wizard',
        'connectWirelessNetwork',
        data
      )
      if (connectWifiWizard != undefined) {
        connectWifiWizard.then(function (data) {
          selfConnWebSocket.emit('pushWizardWirelessConnResults', data)
        })
      }
    })

    connWebSocket.on('safeRemoveDrive', function (data) {
      var selfConnWebSocket = this
      var remove = self.commandRouter.safeRemoveDrive(data)
      if (remove != undefined) {
        remove.then(function (result) {
          self.lastPushedBrowseLibraryObject = result
          selfConnWebSocket.emit('pushBrowseLibrary', result)
        })
      }
    })

    connWebSocket.on('installToDisk', function (data) {
      var selfConnWebSocket = this
      var installDisk = self.commandRouter.executeOnPlugin('system_controller', 'system', 'installToDisk', data)
      if (installDisk != undefined) {
        installDisk.then(function (result) {
          selfConnWebSocket.emit('pushInstallToDisk', result)
        })
      }
    })

    connWebSocket.on('getMyVolumioStatus', function () {
      var selfConnWebSocket = this
      var remove = self.commandRouter.getMyVolumioStatus()
      if (remove != undefined) {
        remove.then(function (result) {
          selfConnWebSocket.emit('pushMyVolumioStatus', result)
        })
      }
    })

    connWebSocket.on('getMyVolumioToken', function (data) {
      var selfConnWebSocket = this
      var remove = self.commandRouter.getMyVolumioToken(data)
      if (remove != undefined) {
        remove.then(function (result) {
          selfConnWebSocket.emit('pushMyVolumioToken', result)
        })
      }
    })

    connWebSocket.on('setMyVolumioToken', function (data) {
      var token = self.commandRouter.setMyVolumioToken(data)
      if (token != undefined) {
        token.then(function (result) {
          self.commandRouter.broadcastMessage('pushMyVolumioToken', {token: result})
        })
      }
    })

    connWebSocket.on('myVolumioLogout', function () {
      self.commandRouter.broadcastMessage('pushMyVolumioLogout', '')
      return self.commandRouter.myVolumioLogout()
    })

    connWebSocket.on('enableMyVolumioDevice', function (device) {
      self.commandRouter.enableMyVolumioDevice(device)
    })

    connWebSocket.on('disableMyVolumioDevice', function (device) {
      self.commandRouter.disableMyVolumioDevice(device)
    })

    connWebSocket.on('deleteMyVolumioDevice', function (device) {
      self.commandRouter.deleteMyVolumioDevice(device)
    })

    connWebSocket.on('getMyMusicPlugins', function () {
      var selfConnWebSocket = this
      var myMusicPlugins = self.commandRouter.getMyMusicPlugins()
      if (myMusicPlugins != undefined) {
        myMusicPlugins.then(function (plugins) {
          selfConnWebSocket.emit('pushMyMusicPlugins', plugins)
        })
      }
    })

    connWebSocket.on('enableDisableMyMusicPlugin', function (data) {
      var selfConnWebSocket = this
      var enableDisableMyMusicPlugin = self.commandRouter.enableDisableMyMusicPlugin(data)
      enableDisableMyMusicPlugin
        .then(function (plugins) {
          selfConnWebSocket.emit('pushMyMusicPlugins', plugins)
        })
        .fail(function (error) {
          self.logger.error(error)
        })
    })

    connWebSocket.on('pinger', function (data) {
      this.emit('ponger', data)
    })

    connWebSocket.on('closeModals', function () {
      self.commandRouter.closeModals()
    })

    connWebSocket.on('deleteFolder', function (data) {
      var selfConnWebSocket = this
      var deleteFolder = self.commandRouter.executeOnPlugin('music_service', 'mpd', 'deleteFolder', data)
      deleteFolder
        .then(function (data) {
          self.printToastMessage(
            'success',
            self.commandRouter.getI18nString('SYSTEM.DELETE_FOLDER'),
            self.commandRouter.getI18nString('SYSTEM.SUCCESSFULLY_DELETED_FOLDER')
          )
          self.lastPushedBrowseLibraryObject = data
          selfConnWebSocket.emit('pushBrowseLibrary', data)
        })
        .fail(function (error) {
          self.printToastMessage(
            'error',
            self.commandRouter.getI18nString('SYSTEM.DELETE_FOLDER'),
            self.commandRouter.getI18nString('SYSTEM.ERROR_DELETING_FOLDER')
          )
          self.logger.error(error)
        })
    })

    connWebSocket.on('getDeviceHWUUID', function () {
      var selfConnWebSocket = this
      var hwuuid = self.commandRouter.getHwuuid()
      selfConnWebSocket.emit('pushDeviceHWUUID', hwuuid)
    })

    connWebSocket.on('getPrivacySettings', function () {
      var selfConnWebSocket = this
      var privacySettings = self.commandRouter.executeOnPlugin('system_controller', 'system', 'getPrivacySettings', '')
      if (privacySettings != undefined) {
        privacySettings.then(function (result) {
          selfConnWebSocket.emit('pushPrivacySettings', result)
        })
      }
    })

    connWebSocket.on('setTOSAccepted', function () {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.executeOnPlugin('miscellanea', 'appearance', 'setTOSAccepted', '')
      returnedData.then(function (data) {
        selfConnWebSocket.emit('pushLatestTOSAccepted', data)
      })
    })

    connWebSocket.on('isLatestTOSAccepted', function () {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.executeOnPlugin('miscellanea', 'appearance', 'isLatestTOSAccepted', '')
      returnedData.then(function (data) {
        selfConnWebSocket.emit('pushLatestTOSAccepted', data)
      })
    })

    connWebSocket.on('pushToastMessage', function ({type, title, message}) {
      self.commandRouter.pushToastMessage(type, title, message)
    })

    connWebSocket.on('getLastPushedBrowseLibrary', function () {
      this.emit('pushBrowseLibrary', self.lastPushedBrowseLibraryObject)
    })

    connWebSocket.on('getInfinityPlayback', function () {
      var selfConnWebSocket = this
      var returnedData = self.commandRouter.executeOnPlugin('miscellanea', 'metavolumio', 'getInfinityPlayback', '')
      selfConnWebSocket.emit('pushInfinityPlayback', returnedData)
    })

    connWebSocket.on('getShutdownOrStandbyMode', function () {
      var selfConnWebSocket = this

      var returnedData = self.commandRouter.getShutdownOrStandbyMode()
      selfConnWebSocket.emit('pushShutdownOrStandbyMode', returnedData)
    })

    connWebSocket.on('setInfinityPlayback', function (data) {
      self.commandRouter.executeOnPlugin('miscellanea', 'metavolumio', 'setInfinityPlayback', data)
      var returnedData = self.commandRouter.executeOnPlugin('miscellanea', 'metavolumio', 'getInfinityPlayback', '')
      if (returnedData && returnedData.enabled !== undefined) {
        const status = returnedData.enabled
          ? self.commandRouter.getI18nString('COMMON.ENABLED')
          : self.commandRouter.getI18nString('COMMON.DISABLED')
        self.printToastMessage('success', self.commandRouter.getI18nString('TRACK_INFO_BAR.INFINITY_PLAY'), status)
      }
      self.broadcastMessage('pushInfinityPlayback', returnedData)
    })

    connWebSocket.on('toggleStopAfterCurrent', function () {
      self.commandRouter.toggleStopAfterCurrent()
    })

    connWebSocket.on('log', function ({type, msg}) {
      const method = type || 'info'
      self.logger[method](`WS log: [${method}] ${msg}`)
    })
  })
}

// Receive console messages from commandRouter and broadcast to all connected clients
InterfaceWebUI.prototype.printConsoleMessage = function (message) {
  this.libSocketIO.emit('printConsoleMessage', message)
  return libQ.resolve()
}

// Receive player queue updates from commandRouter and broadcast to all connected clients
InterfaceWebUI.prototype.pushQueue = function (queue, connWebSocket) {
  // If a specific client is given, push to just that client
  if (connWebSocket) {
    return libQ.fcall(connWebSocket.emit.bind(connWebSocket), 'pushQueue', queue)
    // Else push to all connected clients
  } else {
    return libQ.fcall(this.libSocketIO.sockets.emit('pushQueue', queue))
  }
}

// Push the library root
InterfaceWebUI.prototype.pushLibraryFilters = function (browsedata, connWebSocket) {
  // If a specific client is given, push to just that client
  if (connWebSocket) {
    return libQ.fcall(connWebSocket.emit.bind(connWebSocket), 'pushLibraryFilters', browsedata)
  }
}

// Receive music library data from commandRouter and send to requester
InterfaceWebUI.prototype.pushLibraryListing = function (browsedata, connWebSocket) {
  // If a specific client is given, push to just that client
  if (connWebSocket) {
    return libQ.fcall(connWebSocket.emit.bind(connWebSocket), 'pushLibraryListing', browsedata)
  }
}

// Push the playlist view
InterfaceWebUI.prototype.pushPlaylistIndex = function (browsedata, connWebSocket) {
  // If a specific client is given, push to just that client
  if (connWebSocket) {
    return libQ.fcall(connWebSocket.emit.bind(connWebSocket), 'pushPlaylistIndex', browsedata)
  }
}

InterfaceWebUI.prototype.pushMultiroom = function (selfConnWebSocket) {
  var volumiodiscovery = this.commandRouter.pluginManager.getPlugin('system_controller', 'volumiodiscovery')
  if (volumiodiscovery) {
    var response = volumiodiscovery.getDevices()
    if (response != undefined) {
      selfConnWebSocket.emit('pushMultiRoomDevices', response)
    }
  }
}

// Receive player state updates from commandRouter and broadcast to all connected clients
InterfaceWebUI.prototype.pushState = function (state, connWebSocket) {
  if (connWebSocket) {
    this.pushMultiroom(connWebSocket)
    return libQ.fcall(connWebSocket.emit.bind(connWebSocket), 'pushState', state)
  } else {
    // Push the updated state to all clients
    this.pushMultiroom(this.libSocketIO)
    return libQ.fcall(this.libSocketIO.sockets.emit('pushState', state))
  }
}

InterfaceWebUI.prototype.printToastMessage = function (type, title, message) {
  // Push the message all clients
  this.libSocketIO.emit('pushToastMessage', {
    type: type,
    title: title,
    message: message,
  })
}

InterfaceWebUI.prototype.broadcastToastMessage = function (type, title, message) {
  // Push the message all clients
  this.libSocketIO.sockets.emit('pushToastMessage', {
    type: type,
    title: title,
    message: message,
  })
}

InterfaceWebUI.prototype.pushMultiroomDevices = function (msg) {
  this.libSocketIO.emit('pushMultiRoomDevices', msg)
}

InterfaceWebUI.prototype.logDone = function (timeStart) {
  this.commandRouter.pushConsoleMessage(
    '[' + Date.now() + '] ' + '------------------------------ ' + (Date.now() - timeStart) + 'ms'
  )
  return libQ.resolve()
}

InterfaceWebUI.prototype.logStart = function (sCommand) {
  this.commandRouter.pushConsoleMessage('\n' + '[' + Date.now() + '] ' + '---------------------------- ' + sCommand)
  return libQ.resolve()
}

// Pass the error if we don't want to handle it
InterfaceWebUI.prototype.pushError = function (error) {
  if (typeof error === 'string') {
    return this.commandRouter.pushConsoleMessage.call(this.commandRouter, 'Error: ' + error)
  } else if (typeof error === 'object') {
    return this.commandRouter.pushConsoleMessage.call(this.commandRouter, 'Error:\n' + error.stack)
  }
  return libQ.resolve()
}

InterfaceWebUI.prototype.pushAirplay = function (value) {
  this.logger.debug('Pushing airplay mode: s' + value)
  this.libSocketIO.sockets.emit('pushAirplay', value)
}

InterfaceWebUI.prototype.emitFavourites = function (value) {
  this.logger.info('Pushing Favourites ' + JSON.stringify(value))
  this.libSocketIO.sockets.emit('urifavourites', value)
}

InterfaceWebUI.prototype.broadcastMessage = function (emit, payload) {
  if (emit.msg && emit.value) {
    this.libSocketIO.sockets.emit(emit.msg, emit.value)
  } else {
    this.libSocketIO.sockets.emit(emit, payload)
  }
}

InterfaceWebUI.prototype.emitMessageToSpecificClient = function (id, emit, payload) {
  this.libSocketIO.to(id).emit(emit, payload)
}

InterfaceWebUI.prototype.logClientConnection = function (client) {
  try {
    const socketUserAgent = client.handshake.headers['user-agent'] || 'unknown'
    const socketHost = client.handshake.headers.host
    const socketOrigin = client.handshake.address.split(':').pop()
    const transport = client.handshake.query.transport
    const engineVersion = client.handshake.query.EIO
    const connectedClientsNumber = this.libSocketIO.engine.clientsCount
    this.logger.verbose(
      'New Socket.io Connection to ' +
        socketHost +
        ' from ' +
        socketOrigin +
        ' UA: ' +
        socketUserAgent +
        ' Engine version: ' +
        engineVersion +
        ' Transport: ' +
        transport +
        ' Total Clients: ' +
        connectedClientsNumber
    )
  } catch (e) {}
}
