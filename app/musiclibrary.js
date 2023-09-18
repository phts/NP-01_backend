'use strict'

var libQ = require('kew')
var libFast = require('fast.js')
var libCrypto = require('crypto')
var fs = require('fs-extra')
var _ = require('underscore')

class CoreMusicLibrary {
  constructor(commandRouter) {
    // This fixed variable will let us refer to 'this' object at deeper scopes
    var self = this

    // Save a reference to the parent commandRouter
    self.commandRouter = commandRouter
    self.logger = self.commandRouter.logger

    // Start up a extra metadata handler
    // self.metadataCache = new (require('./metadatacache.js'))(self);

    // Specify the preference for service when adding tracks to the queue
    self.servicePriority = ['mpd', 'spop']

    // The library contains hash tables for genres, artists, albums, and tracks
    self.library = {}
    self.libraryIndex = {}
    self.libraryIndex.root = {
      name: 'root',
      uid: 'root',
      type: 'index',
      children: [],
    }
    self.arrayIndexDefinitions = [
      {
        name: 'Genres by Name',
        table: 'genre',
        sortby: 'name',
        datapath: [
          {
            name: 'name',
            type: 'type',
            uid: 'uid',
          },
        ],
      },
      {
        name: 'Artists by Name',
        table: 'artist',
        sortby: 'name',
        datapath: [
          {
            name: 'name',
            uid: 'uid',
            type: 'type',
            genres: ['genreuids', '#', {name: 'name', uid: 'uid'}],
          },
        ],
      },
      {
        name: 'Albums by Name',
        table: 'album',
        sortby: 'name',
        datapath: [
          {
            name: 'name',
            uid: 'uid',
            type: 'type',
            artists: ['artistuids', '#', {name: 'name', uid: 'uid'}],
          },
        ],
      },
      {
        name: 'Albums by Artist',
        table: 'album',
        sortby: 'artistuids:#:name',
        datapath: [
          {
            name: 'name',
            uid: 'uid',
            type: 'type',
            artists: ['artistuids', '#', {name: 'name', uid: 'uid'}],
          },
        ],
      },
      {
        name: 'Tracks by Name',
        table: 'track',
        sortby: 'name',
        datapath: [
          {
            name: 'name',
            uid: 'uid',
            type: 'type',
            album: ['albumuids', '#0', {name: 'name', uid: 'uid'}],
            artists: ['artistuids', '#', {name: 'name', uid: 'uid'}],
          },
        ],
      },
    ]
    self.queueItemDataPath = [
      {
        name: 'name',
        uid: 'uid',
        type: 'type',
        albums: ['albumuids', '#', {name: 'name', uid: 'uid'}],
        artists: ['artistuids', '#', {name: 'name', uid: 'uid'}],
        tracknumber: 'tracknumber',
        year: 'year',
      },
    ]

    // The Browse Sources Array is the list showed on Browse Page
    var sourcesJson = '/volumio/app/browsesources.json'
    if (fs.existsSync(sourcesJson)) {
      self.browseSources = fs.readJsonSync(sourcesJson, 'utf8', {throws: false})
    } else {
      self.browseSources = [
        {
          albumart: '/albumart?sourceicon=music_service/mpd/favouritesicon.png',
          name: 'Favourites',
          uri: 'favourites',
          plugin_type: '',
          plugin_name: '',
        },
        {
          albumart: '/albumart?sourceicon=music_service/mpd/playlisticon.png',
          name: 'Playlists',
          uri: 'playlists',
          plugin_type: 'music_service',
          plugin_name: 'mpd',
        },
        {
          albumart: '/albumart?sourceicon=music_service/mpd/musiclibraryicon.png',
          name: 'Music Library',
          uri: 'music-library',
          plugin_type: 'music_service',
          plugin_name: 'mpd',
        },
        {
          albumart: '/albumart?sourceicon=music_service/mpd/artisticon.png',
          name: 'Artists',
          uri: 'artists://',
          plugin_type: 'music_service',
          plugin_name: 'mpd',
        },
        {
          albumart: '/albumart?sourceicon=music_service/mpd/albumicon.png',
          name: 'Albums',
          uri: 'albums://',
          plugin_type: 'music_service',
          plugin_name: 'mpd',
        },
        {
          albumart: '/albumart?sourceicon=music_service/mpd/genreicon.png',
          name: 'Genres',
          uri: 'genres://',
          plugin_type: 'music_service',
          plugin_name: 'mpd',
        },
      ]
    }

    // Start library promise as rejected, so requestors do not wait for it if not immediately available.
    // This is okay because no part of Volumio requires a populated library to function.
    // self.libraryReadyDeferred = null;
    // self.libraryReady = libQ.reject('Library not yet loaded.');

    // Attempt to load library from database on disk
    // self.sLibraryPath = __dirname + '/db/musiclibrary';
    // self.loadLibraryFromDB()
    //	.fail(libFast.bind(self.pushError, self));
  }

  getListing(sUid, objOptions) {
    var self = this
    self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'CoreMusicLibrary::getListing')

    return self.libraryReady.then(function () {
      // TODO implement use of nEntries and nOffset for paging of results
      var arrayPath = objOptions.datapath
      var sSortBy = objOptions.sortby

      var objRequested = self.getLibraryObject(sUid)
      if (!sSortBy && arrayPath.length === 0) {
        return objRequested
      } else if (!sSortBy) {
        return self.getObjectInfo(objRequested, arrayPath)
      } else if (arrayPath.length === 0) {
        // TODO - return raw object?
      } else {
        // TODO - sort data before returning
        return self.getObjectInfo(objRequested, arrayPath)
      }
    })
  }

  getIndex(sUid) {
    var self = this
    self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'CoreLibraryFS::getIndex')
    return libQ.resolve(self.libraryIndex[sUid].children)
  }

  addQueueUids(arrayUids) {
    var self = this
    self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'CoreMusicLibrary::addUidsToQueue')

    return self.libraryReady.then(function () {
      var arrayQueueItems = []

      libFast.map(arrayUids, function (sCurrentUid) {
        var objCurrent = self.getLibraryObject(sCurrentUid)
        if (objCurrent.type === 'track') {
          arrayQueueItems.push(self.makeQueueItem(objCurrent))
        } else {
          libFast.map(Object.keys(objCurrent.trackuids), function (sCurrentKey) {
            // TODO - allow adding tracks per a given sort order
            var objCurrentTrack = self.getLibraryObject(sCurrentKey)
            arrayQueueItems.push(self.makeQueueItem(objCurrentTrack))
          })
        }
      })
      self.commandRouter.addQueueItems(arrayQueueItems)
    })
  }

  makeQueueItem(objTrack) {
    var self = this

    for (i = 0; i < self.servicePriority.length; i++) {
      if (self.servicePriority[i] in objTrack.uris) {
        var objQueueItem = objTrack.uris[self.servicePriority[i]]
        objQueueItem.service = self.servicePriority[i]
        var objTrackInfo = self.getObjectInfo(objTrack, self.queueItemDataPath)

        libFast.map(Object.keys(objTrackInfo), function (sCurField) {
          objQueueItem[sCurField] = objTrackInfo[sCurField]
        })

        return objQueueItem
      }
    }
    return {}
  }

  pushError(sReason) {
    var self = this
    self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'CoreMusicLibrary::pushError(' + sReason + ')')

    // Return a resolved empty promise to represent completion
    return libQ.resolve()
  }

  getBrowseSources() {
    var self = this

    return self.browseSources
  }

  getVisibleBrowseSources() {
    var self = this

    var visibleSources = self.setDisabledBrowseSources(self.browseSources)
    return visibleSources
  }

  addToBrowseSources(data) {
    var self = this

    if (data.name != undefined) {
      self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'CoreMusicLibrary::Adding element ' + data.name)

      var replaced = false

      // searching for existing browse source
      for (var i in self.browseSources) {
        var source = self.browseSources[i]
        if (source.name === data.name) {
          source.uri = data.uri
          source.plugin_type = data.plugin_type
          source.plugin_name = data.plugin_name
          replaced = true
        }
      }
      if (replaced === false) {
        self.browseSources.push(data)
      }
    }
    var response = self.getBrowseSources()
    return self.pushBrowseSources(response)
  }

  removeBrowseSource(name) {
    var self = this

    if (name != undefined) {
      self.browseSources = self.browseSources.filter(function (x) {
        if (x.name !== name) {
          return true
        }
      })
    }
    var response = self.getBrowseSources()
    return self.pushBrowseSources(response)
  }

  updateBrowseSources(name, data) {
    var self = this

    if (data && data.name != undefined) {
      for (var i in self.browseSources) {
        var source = self.browseSources[i]
        if (source.name == name) {
          source.name = data.name
          source.uri = data.uri
          source.plugin_type = data.plugin_type
          source.plugin_name = data.plugin_name
          if (data.albumart != undefined) {
            source.albumart = data.albumart
          }
        }
      }
    }
    var response = self.getBrowseSources()

    return self.pushBrowseSources(response)
  }

  setSourceActive(uri) {
    var self = this

    for (var i in self.browseSources) {
      var source = self.browseSources[i]
      if (source.uri == uri) {
        source.active = true
      } else {
        source.active = false
      }
    }

    var response = self.getBrowseSources()

    return self.pushBrowseSources(response)
  }

  executeBrowseSource(curUri, filters) {
    var self = this
    var promise = libQ.defer()

    var response
    // console.log('--------------------------'+curUri)
    if (curUri != undefined) {
      try {
        self
          .parseBrowseSource(curUri)
          .then(function (result) {
            return self.applyBrowseFilters(result, filters)
          })
          .then(function (result) {
            promise.resolve(result)
          })
          .fail(function (error) {
            self.logger.error('Failed to execute browseSource: ' + error)
            promise.reject(error)
          })
      } catch (e) {
        self.logger.error('Failed to execute browseSource, failure: ' + e)
      }
    } else {
      promise.resolve({})
    }
    return promise.promise
  }

  parseBrowseSource(curUri) {
    var self = this

    if (curUri.startsWith('favourites')) {
      return self.commandRouter.playListManager.listFavourites(curUri)
    } else if (curUri.startsWith('search')) {
      var splitted = curUri.split('/')

      return this.search({value: splitted[2]})
    } else if (
      curUri.startsWith('playlists') ||
      curUri.startsWith('artists://') ||
      curUri.startsWith('albums://') ||
      curUri.startsWith('genres://')
    ) {
      return self.commandRouter.executeOnPlugin('music_service', 'mpd', 'handleBrowseUri', curUri)
    } else if (curUri.startsWith('upnp')) {
      return self.commandRouter.executeOnPlugin('music_service', 'upnp_browser', 'handleBrowseUri', curUri)
    } else if (curUri.startsWith('globalUri')) {
      return this.handleGlobalUri(curUri)
    } else {
      for (var i in self.browseSources) {
        var source = self.browseSources[i]

        if (curUri.startsWith(source.uri)) {
          return self.commandRouter.executeOnPlugin(source.plugin_type, source.plugin_name, 'handleBrowseUri', curUri)
        }
      }

      var promise = libQ.defer()
      promise.resolve({})
      return promise.promise
    }
  }

  applyBrowseFilters(data, filters) {
    var self = this
    var promise = libQ.defer()

    if (!_.isEmpty(filters)) {
      var filterObj = JSON.parse(JSON.stringify(data))
    } else {
      var filterObj = data
    }

    // Offset
    if (filters && filters.offset !== undefined) {
      var offset = self.validateFilterNumber(filters.offset)
      if (offset) {
        filterObj = self.applyBrowseOffset(filterObj, offset)
      }
    }

    // Limit
    if (filters && filters.limit !== undefined) {
      var limit = self.validateFilterNumber(filters.limit)
      if (limit) {
        filterObj = self.applyBrowseLimit(filterObj, limit)
      }
    }
    promise.resolve(filterObj)

    return promise.promise
  }

  search(data) {
    var self = this
    var query = {}
    var defer = libQ.defer()
    var deferArray = []
    var searcharray = []
    if (data.value) {
      if (data.type) {
        query = {value: data.value, type: data.type, uri: data.uri}
      } else {
        query = {value: data.value, uri: data.uri}
      }

      var executed = []

      var enableSelectiveSearch
      enableSelectiveSearch = this.commandRouter.sharedVars.get('selective_search')

      /*
       * New search method. If data structure contains fields service or plugin_name that field will be used to pick
       * a plugin for search. If that is not available (only root should be this case) then search will be performed
       * over all plugins.
       *
       * Examples:
       *
       * {"type":"any","value":"paolo","plugin_name":"mpd","plugin_type":"music_service","uri":"music-library"}
       *
       * {"type":"any","value":"sfff","uri":"albums://Nomadi/Ma%20Noi%20No!","service":"mpd"}
       *
       */
      var searchAll = false

      if (enableSelectiveSearch) {
        if (data.service || data.plugin_name) {
          // checking if uri is /. Should revert to search to all
          if (data.uri !== undefined && data.uri === '/') {
            searchAll = true
          } else {
            searchAll = false
          }
        } else {
          searchAll = true
        }
      } else {
        searchAll = true
      }

      if (searchAll) {
        console.log('Searching all installed plugins')
        /**
         * Searching over all plugins
         */
        var searchableSources = self.getVisibleBrowseSources()
        for (var i = 0; i < searchableSources.length; i++) {
          var source = searchableSources[i]

          var key = source.plugin_type + '_' + source.plugin_name
          if (executed.indexOf(key) == -1) {
            executed.push(key)

            var response

            response = self.searchOnPlugin(source.plugin_type, source.plugin_name, query)
            if (response != undefined) {
              deferArray.push(response)
            }
          }
        }
      } else {
        var pluginName = ''
        var pluginType = 'music_service'

        if (data.service) {
          pluginName = data.service
        } else if (data.plugin_name) {
          pluginName = data.plugin_name
        }

        if (data.plugin_type) {
          pluginType = data.plugin_type
        }

        console.log('Searching plugin ' + pluginType + '/' + pluginName)

        response = self.commandRouter.executeOnPlugin(pluginType, pluginName, 'search', query)
        if (response != undefined) {
          deferArray.push(response)
        }
      }

      libQ
        .all(deferArray)
        .then(function (result) {
          self.logger.info('All search sources collected, pushing search results')

          var searchResult = {
            navigation: {
              isSearchResult: true,
              lists: [],
            },
          }

          for (var i in result) {
            if (result[i] !== undefined && result[i] !== null) {
              searchResult.navigation.lists = searchResult.navigation.lists.concat(result[i])
            }
          }
          if (!searchResult.navigation.lists.length) {
            var noResultTitle = {
              type: 'title',
              title: self.commandRouter.getI18nString('COMMON.NO_RESULTS'),
              availableListViews: ['list'],
              items: [],
            }
            searchResult.navigation.lists[0] = noResultTitle
          }
          defer.resolve(searchResult)
        })
        .fail(function (err) {
          self.loger.error('Search error in Plugin: ' + source.plugin_name + '. Details: ' + err)
          defer.reject(new Error())
        })
    } else {
    }
    return defer.promise
  }

  updateBrowseSourcesLang() {
    var self = this

    console.log('Updating browse sources language')
    self.translateDefaultBrowseSources()
    return self.pushBrowseSources(self.browseSources)
  }

  translateDefaultBrowseSources() {
    var self = this

    for (var i in self.browseSources) {
      if (self.browseSources[i] !== undefined) {
        switch (self.browseSources[i].uri) {
          case 'favourites':
            self.browseSources[i].name = self.commandRouter.getI18nString('COMMON.FAVOURITES')
            break
          case 'playlists':
            self.browseSources[i].name = self.commandRouter.getI18nString('COMMON.PLAYLISTS')
            break
          case 'music-library':
            self.browseSources[i].name = self.commandRouter.getI18nString('COMMON.MUSIC_LIBRARY')
            break
          case 'artists://':
            self.browseSources[i].name = self.commandRouter.getI18nString('COMMON.ARTISTS')
            break
          case 'albums://':
            self.browseSources[i].name = self.commandRouter.getI18nString('COMMON.ALBUMS')
            break
          case 'genres://':
            self.browseSources[i].name = self.commandRouter.getI18nString('COMMON.GENRES')
            break
          case 'radio':
            self.browseSources[i].name = self.commandRouter.getI18nString('WEBRADIO.WEBRADIO')
            break
          case 'Last_100':
            self.browseSources[i].name = self.commandRouter.getI18nString('COMMON.LAST_100')
            break
          case 'inputs':
            self.browseSources[i].name = self.commandRouter.getI18nString('MULTIDEVICE.INPUTS')
            break
          case 'upnp':
            self.browseSources[i].name = self.commandRouter.getI18nString('COMMON.MEDIA_SERVERS')
            break
          default:
            console.log('Cannot find translation for source' + self.browseSources[i].name)
        }
      }
    }
  }

  goto(data) {
    var stateMachine = this.commandRouter.stateMachine
    var curState = stateMachine.getTrack(stateMachine.currentPosition)

    var response

    if (curState) {
      data.uri = curState.uri
      response = this.commandRouter.executeOnPlugin('music_service', curState.service, 'goto', data)
    } else response = this.commandRouter.executeOnPlugin('music_service', 'mpd', 'goto', data)
    return response
  }

  pushBrowseSources(data) {
    var self = this

    var visibleSources = self.setDisabledBrowseSources(data)
    self.translateDefaultBrowseSources()
    return this.commandRouter.broadcastMessage('pushBrowseSources', visibleSources)
  }

  setDisabledBrowseSources(data) {
    var self = this
    var visibleSources = []

    try {
      var disabledSources = self.commandRouter.executeOnPlugin('miscellanea', 'my_music', 'getDisabledSources', '')
      for (var i in data) {
        var source = data[i]
        if (!disabledSources.includes(source.uri)) {
          visibleSources.push(source)
        }
      }
    } catch (e) {
      visibleSources = data
    }

    return visibleSources
  }

  validateFilterNumber(filterNumber) {
    var self = this

    if (typeof filterNumber !== 'number') {
      filterNumber = parseInt(filterNumber)
    }
    if (typeof filterNumber === 'number' && filterNumber > 0) {
      return filterNumber
    } else {
      return false
    }
  }

  applyBrowseOffset(data, offset) {
    var self = this

    if (data && data.navigation && data.navigation.lists && data.navigation.lists.length) {
      for (var i in data.navigation.lists) {
        var list = data.navigation.lists[i]
        list.count = list.items.length
        list.items.splice(0, offset)
        if (list.filters === undefined) {
          list.filters = {}
        }
        list.filters.offset = offset
      }
      return data
    } else {
      return data
    }
  }

  applyBrowseLimit(data, limit) {
    var self = this

    if (data && data.navigation && data.navigation.lists && data.navigation.lists.length) {
      for (var i in data.navigation.lists) {
        var list = data.navigation.lists[i]
        if (!list.count) {
          list.count = list.items.length
        }
        list.items = list.items.splice(0, limit)
        if (list.filters === undefined) {
          list.filters = {}
        }
        list.filters.limit = limit
      }
      return data
    } else {
      return data
    }
  }

  searchOnPlugin(plugin_type, plugin_name, query, timeout) {
    var self = this
    var searchTimeoutMS = 5000
    if (timeout !== undefined) {
      searchTimeoutMS = timeout
    }
    var alreadyResolved = false
    var defer = libQ.defer()

    var performedSearch = self.commandRouter.executeOnPlugin(plugin_type, plugin_name, 'search', query)
    if (performedSearch !== undefined) {
      performedSearch
        .then((result) => {
          alreadyResolved = true
          defer.resolve(result)
        })
        .fail((error) => {
          self.logger.error('Failed search in plugin ' + plugin_name + ': ' + error)
          alreadyResolved = true
          defer.resolve(null)
        })
    } else {
      alreadyResolved = true
      defer.resolve(null)
    }

    setTimeout(() => {
      if (!alreadyResolved) {
        self.logger.error('Search in plugin ' + plugin_name + ' timed out')
        defer.resolve(null)
      }
    }, searchTimeoutMS)

    return defer.promise
  }

  handleGlobalUri(uri) {
    var self = this

    // Artist handling
    if (uri.startsWith('globalUriArtist')) {
      return self.handleGlobalUriArtist(uri)
    }

    // Album handling
    if (uri.startsWith('globalUriAlbum')) {
      return self.handleGlobalUriAlbum(uri)
    }

    // Track handling
    if (uri.startsWith('globalUriTrack')) {
      return self.handleGlobalUriTrack(uri)
    }
  }

  handleGlobalUriArtist(uri) {
    var self = this
    var defer = libQ.defer()
    var found = false

    // URI STRUCTURE: globalUriArtist/artist
    var artistToSearch = uri.split('/')[1]

    this.executeGlobalSearch({value: artistToSearch}).then(function (results) {
      for (var i in results) {
        if (self.matchArtist(artistToSearch, results[i])) {
          found = true
          self.executeBrowseSource(results[i].uri).then((data) => {
            defer.resolve(data)
          })
          if (found) {
            break
          }
        }
      }
      if (!found) {
        self.commandRouter.pushToastMessage(
          'error',
          self.commandRouter.getI18nString('COMMON.NO_RESULTS'),
          self.commandRouter.getI18nString('COMMON.ARTIST_NOT_FOUND_IN_YOUR_LIBRARY')
        )
        defer.resolve({})
      }
    })
    return defer.promise
  }

  matchArtist(artistToSearch, item) {
    var self = this

    var artist = item.artist || item.title

    if (self.isEqualString(artistToSearch, artist)) {
      return true
    } else {
      return false
    }
  }

  handleGlobalUriAlbum(uri) {
    var self = this
    var defer = libQ.defer()
    var found = false

    // URI STRUCTURE: globalUriArtist/artist/album
    var artistToSearch = uri.split('/')[1]
    var albumToSearch = uri.split('/')[2]
    var searchString = artistToSearch + ' ' + albumToSearch

    this.executeGlobalSearch({value: searchString}).then(function (results) {
      for (var i in results) {
        if (self.matchAlbum(artistToSearch, albumToSearch, results[i])) {
          found = true
          self.executeBrowseSource(results[i].uri).then((data) => {
            defer.resolve(data)
          })
          if (found) {
            break
          }
        }
      }
      if (!found) {
        self.commandRouter.pushToastMessage(
          'error',
          self.commandRouter.getI18nString('COMMON.NO_RESULTS'),
          self.commandRouter.getI18nString('COMMON.ALBUM_NOT_FOUND_IN_YOUR_LIBRARY')
        )
        defer.resolve({})
      }
    })
    return defer.promise
  }

  matchAlbum(artistToSearch, albumToSearch, item) {
    var self = this

    var artist = item.artist || 'undefined'
    var album = item.album || item.title || 'undefined'

    if (item.type === 'song') {
      return false
    }

    if (self.isEqualString(artist, artistToSearch) && self.isEqualString(album, albumToSearch)) {
      return true
    } else if (item.uri.includes('tidal://album/') && self.isEqualString(album, albumToSearch)) {
      // workaround for Tidal not returning artist name in search results, to fix in browse performer
      return true
    } else {
      return false
    }
  }

  handleGlobalUriTrack(uri) {
    var self = this
    var defer = libQ.defer()
    var found = false

    // URI STRUCTURE: globalUriTrack/artist/track
    var artistToSearch = uri.split('/')[1]
    var trackToSearch = uri.split('/')[2]
    var searchString = artistToSearch + ' ' + trackToSearch
    if (artistToSearch !== undefined && trackToSearch !== undefined) {
      self.matchTrackWithCache(uri).then((result) => {
        if (result && result.uri) {
          defer.resolve(result)
        } else {
          this.executeGlobalSearch({value: searchString}).then(function (results) {
            for (var i in results) {
              if (self.matchTrack(artistToSearch, trackToSearch, results[i])) {
                found = true
                var cachedUri = uri + '/' + results[i].service
                self.saveToCache(cachedUri, results[i])
                defer.resolve(results[i])
                break
              }
            }
            if (!found) {
              defer.resolve({})
            }
          })
        }
      })
    } else {
      defer.resolve({})
    }

    return defer.promise
  }

  saveToCache(path, data) {
    var self = this

    if (
      data &&
      data.service &&
      (data.service === 'tidal' || data.service === 'qobuz' || data.service === 'spotify' || data.service === 'spop')
    ) {
      self.commandRouter.setStreamingCacheValue(path, data)
    }
  }

  matchTrackWithCache(uri) {
    var self = this
    var defer = libQ.defer()
    var deferArray = []

    var searchableSources = self.getVisibleBrowseSources()
    for (var i in searchableSources) {
      var source = searchableSources[i]
      if (source.uri === 'tidal://') {
        deferArray.push(self.commandRouter.getStreamingCacheValue(uri + '/tidal'))
      }
      if (source.uri === 'qobuz://') {
        deferArray.push(self.commandRouter.getStreamingCacheValue(uri + '/qobuz'))
      }
      if (source.uri === 'spotify') {
        deferArray.push(self.commandRouter.getStreamingCacheValue(uri + '/spop'))
      }
    }

    libQ.all(deferArray).then(function (results) {
      self.logger.info('All cached search sources collected')
      if (results && results.length) {
        var cachedItemsArray = []
        for (var i in results) {
          if (results[i] && results[i].uri) {
            cachedItemsArray.push(results[i])
          }
        }
        if (cachedItemsArray.length) {
          cachedItemsArray = _.sortBy(cachedItemsArray, 'priorityScore')
          defer.resolve(results[0])
        } else {
          defer.resolve('')
        }
      } else {
        defer.resolve('')
      }
    })

    return defer.promise
  }

  matchTrack(artistToSearch, trackToSearch, item) {
    var self = this

    var artist = item.artist || 'undefined'
    var track = item.title || 'undefined'

    if (item.type !== 'song') {
      return false
    }

    if (self.isEqualString(artist, artistToSearch) && self.isEqualString(track, trackToSearch)) {
      return true
    }
  }

  isEqualString(a, b) {
    if (a.toLowerCase().trim() === b.toLowerCase().trim()) {
      return true
    } else {
      return false
    }
  }

  executeGlobalSearch(data) {
    var self = this
    var defer = libQ.defer()
    var globalSearchTimeout = 10000

    var safeQuery = data.value.toString().replace(/\n|\r\n|\r/g, '')
    var query = {value: safeQuery, uri: data.uri}

    var deferArray = []
    var executed = []
    var itemsList = []

    var searchableSources = self.getVisibleBrowseSources()
    for (var i = 0; i < searchableSources.length; i++) {
      var source = searchableSources[i]
      var key = source.plugin_type + '_' + source.plugin_name
      if (executed.indexOf(key) == -1 && source.uri !== 'radio') {
        executed.push(key)
        var response
        response = self.searchOnPlugin(source.plugin_type, source.plugin_name, query, globalSearchTimeout)
        if (response != undefined) {
          deferArray.push(response)
        }
      }
    }
    libQ.all(deferArray).then(function (results) {
      self.logger.info('All search sources collected, pushing search results')
      results = _.flatten(results.filter((items) => items))
      if (results && results.length) {
        for (var i = 0; i < results.length; i++) {
          if (results[i] && results[i].items && results[i].items[0] && results[i].items[0].service) {
            var itemsService = results[i].items[0].service
            var priorityScore = self.getPriorityWeightsToItems(itemsService)
            if (results[i] && results[i].items) {
              results[i].items.forEach((item) => (item.priorityScore = priorityScore))
              itemsList = itemsList.concat(results[i].items)
            }
            if (i + 1 == results.length) {
              itemsList = _.sortBy(itemsList, 'priorityScore')
              defer.resolve(itemsList)
            }
          }
        }
      } else {
        defer.resolve([])
      }
    })

    return defer.promise
  }

  getPriorityWeightsToItems(service) {
    // This function provides a priority weight to results based on which service it is from
    // Lower is higher priority: 0 highest priority, 10 lowest priority
    // This privileges quality sources to be selected first
    // TODO Make configurable?
    // TODO Add different weights? like album, resolution, etc
    // in this case make sorting descending

    switch (service) {
      case 'mpd':
        return 0
      case 'tidal':
        return 5
      case 'qobuz':
        return 4
      case 'spop':
        return 6
      default:
        return 10
    }
  }

  superSearch(data) {
    var self = this
    return self.commandRouter.executeOnPlugin('miscellanea', 'metavolumio', 'superSearch', data)
  }

  getNullSearchResult() {
    var searchResult = {
      navigation: {
        isSearchResult: true,
        lists: [],
      },
    }
    var noResultTitle = {availableListViews: ['list'], items: []}
    searchResult.navigation.lists[0] = noResultTitle
    return searchResult
  }
}

module.exports = CoreMusicLibrary
