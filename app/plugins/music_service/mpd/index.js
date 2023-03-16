'use strict'

var cacheManager = require('cache-manager')
var memoryCache = cacheManager.caching({store: 'memory', max: 100, ttl: 0})
var libMpd = require('./lib/mpd.js')
var libQ = require('kew')
var libFast = require('fast.js')
var libFsExtra = require('fs-extra')
var fs = require('fs')
var exec = require('child_process').exec
var parser = require('cue-parser')
var os = require('os')
var execSync = require('child_process').execSync
var ignoreupdate = false
// tracknumbers variable below adds track numbers to titles if set to true. Set to false for normal behavour.
var tracknumbers = false
// compilation array below adds different strings used to describe albumartist in compilations or 'multiple artist' albums
var compilation = ['Various', 'various', 'Various Artists', 'various artists', 'VA', 'va']
// atistsort variable below will list artists by albumartist if set to true or artist if set to false
var artistsort = true
var dsd_autovolume = false
var singleBrowse = false
var startup = true
var stickingMusicLibrary = false

function parseMpdOutput(lines, startFrom) {
  const map = {
    Album: 'album',
    AlbumArtist: 'albumartist',
    Artist: 'artist',
    Date: 'year',
    Genre: 'genre',
    Pos: 'position',
    Time: 'duration',
    Title: 'title',
    Track: 'tracknumber',
  }
  const res = Object.values(map).reduce((acc, key) => {
    acc[key] = ''
    return acc
  }, {})
  res.path = lines[startFrom].slice(6).trim()
  const filename = res.path.split('/').pop()
  for (let i = startFrom + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line) {
      continue
    }
    const key = line.split(':')[0]
    if (!key) {
      continue
    }
    if (['file', 'directory'].includes(key)) {
      break
    }
    const value = line.substr(line.indexOf(':') + 1, line.length).trim()
    res[map[key]] = value
  }
  if (tracknumbers) {
    if (res.tracknumber && res.title) {
      res.title = res.tracknumber.padStart(2, '0') + ' - ' + res.title
    }
  }
  res.duration = res.duration ? parseInt(res.duration) : 0
  res.tracknumber = res.tracknumber ? parseInt(res.tracknumber) : 0
  if (!res.title) {
    res.title = filename
  }
  res.albumartistOrArtist = res.albumartist || res.artist
  return res
}

class ControllerMpd {
  constructor(context) {
    // This fixed variable will let us refer to 'this' object at deeper scopes
    this.context = context
    this.commandRouter = this.context.coreCommand
    this.logger = this.context.logger
    this.configManager = this.context.configManager
    this.config = new (require('v-conf'))()
    this.registeredCallbacks = []
  }

  play(N) {
    this.logger.info('ControllerMpd::play ' + N)
    return this.sendMpdCommand('play', [N])
  }

  add(data) {
    var self = this
    this.commandRouter.pushToastMessage('success', data + self.commandRouter.getI18nString('COMMON.ADD_QUEUE_TEXT_1'))
    return this.sendMpdCommand('add', [data])
  }

  remove(position) {
    this.logger.info('ControllerMpd::remove ' + position)
    return this.sendMpdCommand('delete', [position])
  }

  next() {
    this.logger.info('ControllerMpd::next')
    return this.sendMpdCommand('next', [])
  }

  previous() {
    this.logger.info('ControllerMpd::previous')
    return this.sendMpdCommand('previous', [])
  }

  random(randomcmd) {
    var self = this
    var string = randomcmd ? 1 : 0
    this.commandRouter.pushToastMessage(
      'success',
      'Random',
      string === 1 ? self.commandRouter.getI18nString('COMMON.ON') : self.commandRouter.getI18nString('COMMON.OFF')
    )
    return this.sendMpdCommand('random', [string])
  }

  repeat(repeatcmd) {
    var self = this
    var string = repeatcmd ? 1 : 0
    this.commandRouter.pushToastMessage(
      'success',
      'Repeat',
      string === 1 ? self.commandRouter.getI18nString('COMMON.ON') : self.commandRouter.getI18nString('COMMON.ON')
    )
    return this.sendMpdCommand('repeat', [string])
  }

  clear() {
    this.logger.info('ControllerMpd::clear')
    return this.sendMpdCommand('clear', [])
  }

  enableOutput(output) {
    this.logger.info('Enable Output ' + output)
    return this.sendMpdCommand('enableoutput', [output])
  }

  disableOutput(output) {
    this.logger.info('Disable Output ' + output)
    return this.sendMpdCommand('disableoutput', [output])
  }

  updateMpdDB() {
    this.logger.info('Update mpd DB')
    return this.sendMpdCommand('update', [])
  }

  addPlay(fileName) {
    var self = this

    this.logger.info('ControllerMpd::addPlay')
    this.commandRouter.pushToastMessage(
      'Success',
      '',
      fileName + self.commandRouter.getI18nString('COMMON.ADD_QUEUE_TEXT_1')
    )

    // Add playlists and cue with load command
    if (fileName.endsWith('.cue') || fileName.endsWith('.pls') || fileName.endsWith('.m3u')) {
      this.logger.info('Adding Playlist: ' + fileName)
      return this.sendMpdCommandArray([
        {command: 'clear', parameters: []},
        {command: 'load', parameters: [fileName]},
        {command: 'play', parameters: []},
      ])
    } else if (fileName.startsWith('albums')) {
      return self.playAlbum(fileName)
    } else {
      return this.sendMpdCommandArray([
        {command: 'clear', parameters: []},
        {command: 'add', parameters: [fileName]},
        {command: 'play', parameters: []},
      ])
    }
    /* .then(function() {
       self.commandRouter.volumioPlay();

       }); */
  }

  addPlayCue(data) {
    if (data.number !== undefined) {
      this.logger.info('Adding CUE individual entry: ' + data.number + ' ' + data.uri)
      var cueItem = this.explodeCue(data.uri, data.number)

      this.commandRouter.addQueueItems([
        {
          uri: cueItem.uri,
          type: cueItem.type,
          service: cueItem.service,
          name: cueItem.name,
          artist: cueItem.artist,
          album: cueItem.album,
          number: cueItem.number,
          albumart: cueItem.albumart,
          year: cueItem.date,
        },
      ])

      var index = this.commandRouter.stateMachine.playQueue.arrayQueue.length
      this.commandRouter.volumioPlay(index)
    }
  }

  getTracklist() {
    var self = this
    this.logger.info('ControllerMpd::getTracklist')

    return self.mpdReady
      .then(function () {
        return libQ.nfcall(self.clientMpd.sendCommand.bind(self.clientMpd), libMpd.cmd('listallinfo', []))
      })
      .then(function (objResult) {
        var listInfo = self.parseListAllInfoResult(objResult)
        return listInfo.tracks
      })
  }

  parseListAllInfoResult(sInput) {
    const lines = sInput.split('\n')
    const result = {
      tracks: [],
      playlists: [],
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.indexOf('file:') === 0) {
        const {path, artist, album, title, year, tracknumber, duration, albumartist} = parseMpdOutput(lines, i)
        result.tracks.push({
          service: this.servicename,
          uri: path,
          browsepath: [this.displayname].concat(path.split('/').slice(0, -1)),
          artists: artist ? artist.split(',').map((x) => x.trim()) : [],
          album,
          name: title,
          genres: [],
          performers: albumartist ? albumartist.split(',').map((x) => x.trim()) : [],
          tracknumber,
          year,
          duration,
        })
      }
    }
    return result
  }

  getState() {
    this.logger.info('ControllerMpd::getState')
    var timeCurrentUpdate = Date.now()
    this.timeLatestUpdate = timeCurrentUpdate

    var self = this
    return self.sendMpdCommand('status', []).then(function (objState) {
      var collectedState = self.parseState(objState)
      // If there is a track listed as currently playing, get the track info
      if (collectedState.position !== null) {
        return self.sendMpdCommand('playlistinfo', [collectedState.position]).then(function (objTrackInfo) {
          var trackinfo = self.parseTrackInfo(objTrackInfo)
          collectedState.isStreaming = trackinfo.isStreaming != undefined ? trackinfo.isStreaming : false
          collectedState.title = trackinfo.title
          collectedState.artist = trackinfo.artist
          collectedState.album = trackinfo.album
          collectedState.year = trackinfo.year
          collectedState.tracknumber = trackinfo.tracknumber
          collectedState.uri = trackinfo.uri
          collectedState.trackType = trackinfo.trackType.split('?')[0]
          collectedState.bitrate = collectedState.bitrate || trackinfo.bitrate
          return collectedState
        })
        // Else return null track info
      } else {
        collectedState.isStreaming = false
        collectedState.title = null
        collectedState.artist = null
        collectedState.album = null
        // collectedState.albumart = null;
        collectedState.uri = null
        return collectedState
      }
    })
  }

  haltIfNewerUpdateRunning(data, timeCurrentThread) {
    var self = this
    this.logger.info('ControllerMpd::haltIfNewerUpdateRunning')

    if (self.timeLatestUpdate > timeCurrentThread) {
      return libQ.reject('Alert: Aborting status update - newer one detected')
    } else {
      return libQ.resolve(data)
    }
  }

  pushState(state) {
    var self = this
    this.logger.info('ControllerMpd::pushState')

    return self.commandRouter.servicePushState(state, self.servicename)
  }

  pushError(sReason) {
    var self = this
    self.logger.error('ControllerMpd::pushError: ' + sReason)

    // Return a resolved empty promise to represent completion
    return libQ.resolve()
  }

  sendMpdCommand(sCommand, arrayParameters) {
    var self = this
    self.logger.verbose('ControllerMpd::sendMpdCommand ' + sCommand)

    const start = Date.now()
    return self.mpdReady
      .then(function () {
        return libQ.nfcall(self.clientMpd.sendCommand.bind(self.clientMpd), libMpd.cmd(sCommand, arrayParameters))
      })
      .then(function (response) {
        var respobject = libMpd.parseKeyValueMessage(response)
        // If there's an error show an alert on UI
        if ('error' in respobject) {
          self.commandRouter.broadcastToastMessage('error', 'Error', respobject.error)
          self.sendMpdCommand('clearerror', [])
        }
        const stop = Date.now()
        self.logger.info('sendMpdCommand ' + sCommand + ' took ' + (stop - start) + ' milliseconds')

        return libQ.resolve(respobject)
      })
  }

  sendMpdCommandArray(arrayCommands) {
    var self = this

    return self.mpdReady
      .then(function () {
        return libQ.nfcall(
          self.clientMpd.sendCommands.bind(self.clientMpd),
          libFast.map(arrayCommands, function (currentCommand) {
            self.logger.verbose('MPD COMMAND ' + currentCommand)
            return libMpd.cmd(currentCommand.command, currentCommand.parameters)
          })
        )
      })
      .then(libMpd.parseKeyValueMessage.bind(libMpd))
  }

  parseTrackInfo(objTrackInfo) {
    var self = this
    self.logger.verbose('ControllerMpd::parseTrackInfo')

    // this.commandRouter.logger.info("OBJTRACKINFO "+JSON.stringify(objTrackInfo));
    var resp = {}

    if (objTrackInfo.Time === 0) {
      resp.isStreaming = true
    }

    if (objTrackInfo.file != undefined) {
      resp.uri = objTrackInfo.file
      resp.trackType = objTrackInfo.file.split('.').pop()
      if (resp.trackType.length > 10) {
        resp.trackType = ''
      }
      if (resp.uri.indexOf('cdda:///') >= 0) {
        resp.trackType = 'CD Audio'
        resp.title = resp.uri.replace('cdda:///', 'Track ')
      } else if (resp.uri.indexOf('qobuz') >= 0) {
        resp.trackType = 'qobuz'
      } else if (resp.uri.indexOf('tidal') >= 0) {
        resp.trackType = 'tidal'
      } else if (resp.uri.indexOf('http://') >= 0) {
        resp.service = 'dirble'
        if (objTrackInfo.file.indexOf('bbc') >= 0 && objTrackInfo.Name) {
          objTrackInfo.Name = objTrackInfo.Name.replace(/_/g, ' ').replace('bbc', 'BBC')
          objTrackInfo.file = objTrackInfo.Name
        }
      }
    } else {
      resp.uri = null
    }

    if (objTrackInfo.Title != undefined) {
      resp.title = objTrackInfo.Title
    } else {
      var file = objTrackInfo.file
      if (file !== undefined) {
        var filetitle = file.replace(/^.*\/(?=[^/]*$)/, '')

        resp.title = filetitle
      }
    }

    if (objTrackInfo.Artist != undefined) {
      resp.artist = objTrackInfo.Artist
    } else if (objTrackInfo.Name != undefined) {
      resp.artist = objTrackInfo.Name
    } else {
      resp.artist = null
    }

    if (objTrackInfo.Album != undefined) {
      resp.album = objTrackInfo.Album
    } else {
      resp.album = null
    }

    var web

    if (objTrackInfo.Artist != undefined) {
      if (objTrackInfo.Album != undefined) {
        web = {artist: objTrackInfo.Artist, album: objTrackInfo.Album}
      } else {
        web = {artist: objTrackInfo.Artist}
      }
    }

    var artUrl

    if (resp.isStreaming) {
      artUrl = this.getAlbumArt(web)
    } else {
      artUrl = this.getAlbumArt(web, file)
    }

    if (objTrackInfo.bitrate) {
      resp.bitrate = objTrackInfo.bitrate
    } else {
      resp.bitrate = null
    }

    resp.albumart = artUrl
    resp.year = objTrackInfo.Date
    resp.tracknumber = objTrackInfo.Track
    return resp
  }

  parsePlaylist() {}

  parseState(objState) {
    var self = this
    self.logger.verbose('ControllerMpd::parseState')

    // Pull track duration out of status message
    var nDuration = null
    if ('time' in objState) {
      var arrayTimeData = objState.time.split(':')
      nDuration = Math.round(Number(arrayTimeData[1]))
    }

    // Pull the elapsed time
    var nSeek = null
    if ('elapsed' in objState) {
      nSeek = Math.round(Number(objState.elapsed) * 1000)
    }

    // Pull the queue position of the current track
    var nPosition = null
    if ('song' in objState) {
      nPosition = Number(objState.song)
    }

    // Pull audio metrics
    let bitdepth = null
    let samplerate = null
    let channels = null
    if ('audio' in objState) {
      const objMetrics = objState.audio.split(':')
      samplerate = Number(objMetrics[0]) / 1000
      bitdepth = Number(objMetrics[1]) + ' bit'
      channels = Number(objMetrics[2])
      if (objMetrics[1] === 'f') {
        samplerate = samplerate + ' kHz'
        bitdepth = '32 bit'
      } else if (objMetrics[0] === 'dsd64') {
        samplerate = '2.82 MHz'
        bitdepth = '1 bit'
        channels = 2
      } else if (objMetrics[0] === 'dsd128') {
        samplerate = '5.64 MHz'
        bitdepth = '1 bit'
        channels = 2
      } else if (objMetrics[0] === 'dsd256') {
        samplerate = '11.28 MHz'
        bitdepth = '1 bit'
        channels = 2
      } else if (objMetrics[0] === 'dsd512') {
        samplerate = '22.58 MHz'
        bitdepth = '1 bit'
        channels = 2
      } else if (objMetrics[1] === 'dsd') {
        if (samplerate === 352.8) {
          samplerate = '2.82 MHz'
          bitdepth = '1 bit'
        } else if (samplerate === 705.6) {
          samplerate = '5.64 MHz'
          bitdepth = '1 bit'
        } else if (samplerate === 1411.2) {
          samplerate = '11.2 MHz'
          bitdepth = '1 bit'
        } else {
          samplerate = samplerate + ' kHz'
        }
      } else {
        samplerate = samplerate + ' kHz'
      }
    }
    var random = null
    if ('random' in objState) {
      random = objState.random === 1
    }

    var repeat = null
    if ('repeat' in objState) {
      repeat = objState.repeat === 1
    }

    var sStatus = null
    if ('state' in objState) {
      sStatus = objState.state
    }

    var updatedb = false
    if ('updating_db' in objState) {
      updatedb = true
    }

    var bitrate = null
    if ('bitrate' in objState) {
      if (objState.bitrate !== '0') {
        bitrate = objState.bitrate + ' Kbps'
      }
    }

    return {
      status: sStatus,
      position: nPosition,
      seek: nSeek,
      duration: nDuration,
      samplerate,
      bitdepth,
      channels,
      random: random,
      updatedb: updatedb,
      repeat: repeat,
      bitrate: bitrate,
    }
  }

  logDone(timeStart) {
    var self = this
    self.commandRouter.pushConsoleMessage('------------------------------ ' + (Date.now() - timeStart) + 'ms')
    return libQ.resolve()
  }

  logStart(sCommand) {
    var self = this
    self.commandRouter.pushConsoleMessage('\n' + '---------------------------- ' + sCommand)
    return libQ.resolve()
  }

  onVolumioStart() {
    var self = this

    this.commandRouter.sharedVars.registerCallback('alsa.outputdevice', this.outputDeviceCallback.bind(this))
    var configFile = self.commandRouter.pluginManager.getConfigurationFile(self.context, 'config.json')
    self.config.loadFile(configFile)
    self.loadLibrarySettings()
    dsd_autovolume = self.config.get('dsd_autovolume', false)
    self.getPlaybackMode()

    return self.mpdInit()
  }

  mpdInit() {
    var self = this
    var defer = libQ.defer()

    if (process.env.WRITE_MPD_CONFIGURATION_ON_STARTUP === 'true') {
      self.logger.info('Creating MPD Configuration file')
      self.createMPDFile(function (error) {
        if (error !== undefined && error !== null) {
          self.logger.error('Could not create MPD File on system start: ' + error)
          defer.resolve()
        } else {
          self.restartMpd(function (error) {
            if (error !== null && error != undefined) {
              self.logger.error('Cannot start MPD on system Start: ' + error)
              defer.resolve()
            } else {
              defer.resolve(self.initializeMpdConnection())
            }
          })
        }
      })
    } else {
      defer.resolve(self.initializeMpdConnection())
    }
    return defer.promise
  }

  initializeMpdConnection() {
    var self = this
    var defer = libQ.defer()

    // Connect to MPD only if process MPD is running
    exec('/bin/pidof mpd', {uid: 1000, gid: 1000}, function (error, stdout) {
      if (error) {
        self.logger.error('Cannot initialize  MPD Connection: MPD is not running')
        defer.resolve()
      } else {
        if (stdout && stdout.length) {
          self.logger.info('MPD running with PID' + stdout + ' ,establishing connection')
          self.mpdEstablish()
        } else {
          self.logger.error('Cannot initialize  MPD Connection: MPD is not running')
        }
        defer.resolve()
      }
    })
  }

  mpdEstablish() {
    var self = this

    // TODO use names from the package.json instead
    self.servicename = 'mpd'
    self.displayname = 'MPD'

    // getting configuration

    // Save a reference to the parent commandRouter
    self.commandRouter = self.context.coreCommand
    // Connect to MPD
    self.mpdConnect()

    // Make a promise for when the MPD connection is ready to receive events
    self.mpdReady = libQ.nfcall(self.clientMpd.on.bind(self.clientMpd), 'ready')

    self.mpdReady.then(function () {
      if (startup) {
        startup = false
        self.checkUSBDrives()
        self.listAlbums()
      }
    })

    // Catch and log errors
    self.clientMpd.on('error', function (err) {
      self.logger.error('MPD error: ' + err)
      if (err === "{ [Error: This socket has been ended by the other party] code: 'EPIPE' }") {
        // Wait 5 seconds before trying to reconnect
        setTimeout(function () {
          self.mpdEstablish()
        }, 5000)
      } else {
        self.logger.error(err)
      }
    })

    // This tracks the the timestamp of the newest detected status change
    self.timeLatestUpdate = 0
    self.updateQueue()

    // TODO remove pertaining function when properly found out we don't need em
    // self.fswatch();
    // When playback status changes
    self.clientMpd.on('system', function (status) {
      var timeStart = Date.now()

      if (!ignoreupdate && status !== 'playlist' && status != undefined) {
        self
          .logStart('MPD announces state update: ' + status)
          .then(self.getState.bind(self))
          .then(self.pushState.bind(self))
          .fail(self.pushError.bind(self))
          .done(function () {
            return self.logDone(timeStart)
          })
      } else {
        self.logger.info('Ignoring MPD Status Update')
      }
    })

    self.clientMpd.on('system-playlist', function () {
      var timeStart = Date.now()

      if (!ignoreupdate) {
        self
          .logStart('MPD announces system playlist update')
          .then(self.updateQueue.bind(self))
          .fail(self.pushError.bind(self))
          .done(function () {
            return self.logDone(timeStart)
          })
      } else {
        self.logger.info('Ignoring MPD Status Update')
      }
    })

    // Notify that The mpd DB has changed
    self.clientMpd.on('system-database', function () {
      // return self.commandRouter.fileUpdate();
      // return self.reportUpdatedLibrary();
      // Refresh AlbumList - delete the current AlbumList cache entry
      memoryCache.del('cacheAlbumList', function () {})
      // Store new AlbumList in cache
      self.listAlbums()
      self.logger.info('MPD Database updated - AlbumList cache refreshed')
    })

    self.clientMpd.on('system-update', function () {
      if (!ignoreupdate) {
        self.sendMpdCommand('status', []).then(function (objState) {
          var state = self.parseState(objState)
          execSync('/bin/sync', {uid: 1000, gid: 1000})
          return self.commandRouter.fileUpdate(state.updatedb)
        })
      } else {
        self.logger.info('Ignoring MPD Status Update')
      }
    })
  }

  mpdConnect() {
    var self = this

    var nHost = self.config.get('nHost')
    var nPort = self.config.get('nPort')
    self.clientMpd = libMpd.connect({port: nPort, host: nHost})
  }

  outputDeviceCallback() {
    var self = this

    var defer = libQ.defer()
    self.logger.info('Output device has changed, restarting MPD')
    self.createMPDFile(function (error) {
      if (error !== undefined && error !== null) {
        self.commandRouter.pushToastMessage(
          'error',
          self.commandRouter.getI18nString('COMMON.CONFIGURATION_UPDATE'),
          self.commandRouter.getI18nString('COMMON.CONFIGURATION_UPDATE_ERROR')
        )
        defer.resolve({})
      } else {
        // self.commandRouter.pushToastMessage('success', self.commandRouter.getI18nString('mpd_configuration_update'), self.commandRouter.getI18nString('mpd_playback_configuration_error'));

        self.restartMpd(function (error) {
          if (error !== null && error != undefined) {
            self.logger.info('Cannot restart MPD: ' + error)
            // self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('mpd_player_restart'), self.commandRouter.getI18nString('mpd_player_restart_error'));
          } else {
            self.commandRouter.pushToastMessage(
              'success',
              self.commandRouter.getI18nString('COMMON.CONFIGURATION_UPDATE'),
              self.commandRouter.getI18nString('COMMON.PLAYER_RESTARTED')
            )
          }
          defer.resolve({})
        })
      }
    })
  }

  savePlaybackOptions(data) {
    var self = this

    var defer = libQ.defer()

    self.config.set('dsd_autovolume', data['dsd_autovolume'])
    self.config.set('volume_normalization', data['volume_normalization'])
    self.config.set('audio_buffer_size', data['audio_buffer_size'].value)
    self.config.set('buffer_before_play', data['buffer_before_play'].value)
    self.config.set('dop', data['dop'].value)
    dsd_autovolume = data['dsd_autovolume']

    var isonew = data.iso
    var iso = self.config.get('iso', false)

    if (self.config.get('persistent_queue') == null) {
      self.config.addConfigValue('persistent_queue', 'boolean', data['persistent_queue'])
    } else {
      self.config.set('persistent_queue', data['persistent_queue'])
    }

    var playbackModeNew = data['playback_mode_list'].value
    if (playbackModeNew !== process.env.PLAYBACK_MODE) {
      self.setPlaybackMode(playbackModeNew)
    }

    if (isonew != iso) {
      self.config.set('iso', data['iso'])
      if (isonew) {
        // iso enabled
        execSync('/usr/bin/sudo /bin/systemctl stop mpd', {uid: 1000, gid: 1000, encoding: 'utf8'})
        execSync('echo "volumio" | sudo -S /bin/cp -f /usr/bin/mpdsacd /usr/bin/mpd', {
          uid: 1000,
          gid: 1000,
          encoding: 'utf8',
        })
        execSync('/bin/sync', {uid: 1000, gid: 1000, encoding: 'utf8'})
        setTimeout(function () {
          exec('/usr/bin/mpc update', {uid: 1000, gid: 1000}, function (error) {
            if (error) {
              self.logger.error('Cannot Update MPD DB: ' + error)
            }
          })
          var responseData = {
            title: self.commandRouter.getI18nString('PLAYBACK_OPTIONS.PLAYBACK_OPTIONS_TITLE') + ': ISO Playback',
            message: 'ISO Playback ' + self.commandRouter.getI18nString('PLAYBACK_OPTIONS.I2S_DAC_ACTIVATED_MESSAGE'),
            size: 'lg',
            buttons: [
              {
                name: self.commandRouter.getI18nString('COMMON.RESTART'),
                class: 'btn btn-info',
                emit: 'reboot',
                payload: '',
              },
            ],
          }

          self.commandRouter.broadcastMessage('openModal', responseData)
        }, 1000)
      } else {
        execSync('/usr/bin/sudo /usr/bin/killall mpd', {uid: 1000, gid: 1000, encoding: 'utf8'})
        execSync('echo "volumio" | sudo -S /bin/cp -f /usr/bin/mpdorig /usr/bin/mpd', {
          uid: 1000,
          gid: 1000,
          encoding: 'utf8',
        })
        execSync('/bin/sync', {uid: 1000, gid: 1000, encoding: 'utf8'})
        setTimeout(function () {
          exec('/usr/bin/mpc update', {uid: 1000, gid: 1000}, function (error) {
            if (error) {
              self.logger.error('Cannot Update MPD DB: ' + error)
            }
          })
        }, 5000)
      }
    }

    self.createMPDFile(function (error) {
      if (error !== undefined && error !== null) {
        // self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('mpd_configuration_update'), self.commandRouter.getI18nString('mpd_configuration_update_error'));
        defer.resolve({})
      } else {
        // self.commandRouter.pushToastMessage('success', self.commandRouter.getI18nString('mpd_configuration_update'), self.commandRouter.getI18nString('mpd_playback_configuration_error'));

        self.restartMpd(function (error) {
          if (error !== null && error != undefined) {
            self.logger.error('Cannot restart MPD: ' + error)
            self.commandRouter.pushToastMessage(
              'error',
              self.commandRouter.getI18nString('PLAYBACK_OPTIONS.PLAYBACK_OPTIONS_TITLE'),
              self.commandRouter.getI18nString('COMMON.SETTINGS_SAVE_ERROR')
            )
          } else {
            self.commandRouter.pushToastMessage(
              'success',
              self.commandRouter.getI18nString('PLAYBACK_OPTIONS.PLAYBACK_OPTIONS_TITLE'),
              self.commandRouter.getI18nString('COMMON.SETTINGS_SAVED_SUCCESSFULLY')
            )
          }
          defer.resolve({})
        })
      }
    })

    return defer.promise
  }

  saveResampleOptions() {
    var self = this
    var defer = libQ.defer()
    self.createMPDFile(function (error) {
      if (error !== undefined && error !== null) {
        // self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('mpd_configuration_update'), self.commandRouter.getI18nString('mpd_configuration_update_error'));
        defer.resolve({})
      } else {
        // self.commandRouter.pushToastMessage('success', self.commandRouter.getI18nString('mpd_configuration_update'), self.commandRouter.getI18nString('mpd_playback_configuration_error'));

        self.restartMpd(function (error) {
          if (error !== null && error != undefined) {
            self.logger.error('Cannot restart MPD: ' + error)
            // self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('mpd_player_restart'), self.commandRouter.getI18nString('mpd_player_restart_error'));
          }
          // self.commandRouter.pushToastMessage('success', self.commandRouter.getI18nString('mpd_player_restart'), self.commandRouter.getI18nString('mpd_player_restart_success'));
          else {
            defer.resolve({})
          }
        })
      }
    })

    return defer.promise
  }

  restartMpd(callback) {
    var self = this

    if (callback) {
      exec('/usr/bin/sudo /bin/systemctl restart mpd.service ', {uid: 1000, gid: 1000}, function (error) {
        self.mpdEstablish()
        callback(error)
      })
    } else {
      exec('/usr/bin/sudo /bin/systemctl restart mpd.service ', {uid: 1000, gid: 1000}, function (error) {
        if (error) {
          self.logger.error('Cannot restart MPD: ' + error)
        } else {
          self.mpdEstablish()
        }
      })
    }
  }

  createMPDFile(callback) {
    var self = this

    exec('/usr/bin/sudo /bin/chmod 777 /etc/mpd.conf', {uid: 1000, gid: 1000}, function (error) {
      if (error != null) {
        self.logger.info('Error setting mpd conf file perms: ' + error)
      } else {
        self.logger.info('MPD Permissions set')
      }
    })

    try {
      fs.readFile(__dirname + '/mpd.conf.tmpl', 'utf8', function (err, data) {
        if (err) {
          return self.logger.error(err)
        }
        var outdev = self.getAdditionalConf('audio_interface', 'alsa_controller', 'outputdevice')
        var mixer = self.getAdditionalConf('audio_interface', 'alsa_controller', 'mixer')

        var resampling = self.getAdditionalConf('audio_interface', 'alsa_controller', 'resampling')
        var resampling_bitdepth = self.getAdditionalConf(
          'audio_interface',
          'alsa_controller',
          'resampling_target_bitdepth'
        )
        var resampling_samplerate = self.getAdditionalConf(
          'audio_interface',
          'alsa_controller',
          'resampling_target_samplerate'
        )
        var resampling_quality = self.getAdditionalConf('audio_interface', 'alsa_controller', 'resampling_quality')
        var ffmpeg = self.config.get('ffmpegenable', false)

        var mixerdev = ''
        var mixerstrings = ''

        if (process.env.MODULAR_ALSA_PIPELINE === 'true') {
          var realDev = outdev
          outdev = self.commandRouter.sharedVars.get('alsa.outputdevice')
          if (self.getAdditionalConf('audio_interface', 'alsa_controller', 'softvolume')) {
            mixerdev = 'SoftMaster'
          } else {
            if (realDev.indexOf(',') >= 0) {
              mixerdev = 'hw:' + realDev
            } else {
              mixerdev = 'hw:' + realDev + ',0'
            }
          }
        } else {
          if (outdev != 'softvolume') {
            var realDev = outdev
            if (outdev.indexOf(',') >= 0) {
              mixerdev = 'hw:' + outdev
              outdev = 'hw:' + outdev
            } else {
              mixerdev = 'hw:' + outdev
              outdev = 'hw:' + outdev + ',0'
            }
          } else {
            mixerdev = 'SoftMaster'
            var realDev = self.getAdditionalConf('audio_interface', 'alsa_controller', 'softvolumenumber')
          }
        }

        var mpdvolume = self.getAdditionalConf('audio_interface', 'alsa_controller', 'mpdvolume')
        if (mpdvolume == undefined) {
          mpdvolume = false
        }

        var conf1 = data.replace('${gapless_mp3_playback}', self.checkTrue('gapless_mp3_playback'))
        var conf2 = conf1.replace('${device}', outdev)
        var conf3 = conf2.replace('${volume_normalization}', self.checkTrue('volume_normalization'))
        var conf4 = conf3.replace('${audio_buffer_size}', self.config.get('audio_buffer_size'))
        var conf5 = conf4.replace('${buffer_before_play}', self.config.get('buffer_before_play'))
        if (self.config.get('dop', false)) {
          var dop = 'yes'
        } else {
          var dop = 'no'
        }

        // VIM1 fix for buffer on SPDIF OUTPUT
        try {
          var systemHw = execSync("cat /etc/os-release | grep ^VOLUMIO_HARDWARE | tr -d 'VOLUMIO_HARDWARE=\"'", {
            uid: 1000,
            gid: 1000,
          })
            .toString()
            .replace('\n', '')
        } catch (e) {
          self.logger.error('Could not parse Volumio hardware: ' + e)
        }

        var dopString = dop
        if (systemHw && systemHw === 'vim1' && realDev && realDev === '0,1') {
          dopString = dop + '"' + os.EOL + '                buffer_time     "5000000'
        }

        // KVIM1 and KVIM2 fix for audio issues with 44.1Khz
        if (systemHw && (systemHw === 'kvim1' || systemHw === 'kvim2')) {
          dopString = dop + '"' + os.EOL + '                buffer_time     "4000000"'
          dopString = dopString + os.EOL + '                period_time     "40000'
        }

        var conf6 = conf5.replace('${dop}', dopString)

        if (mixer) {
          if (mixer.length > 0 && mpdvolume) {
            mixerstrings =
              'mixer_device    "' +
              mixerdev +
              '"' +
              os.EOL +
              '                mixer_control   "' +
              mixer +
              '"' +
              os.EOL +
              '                mixer_type      "hardware"' +
              os.EOL
          }
        }

        var conf7 = conf6.replace('${mixer}', mixerstrings)

        if (self.config.get('iso', false)) {
          var conf9 = conf7.replace('${format}', '')
        } else {
          var multiThreadSox = self.checkIfSoxCanBeMultithread()
          if (multiThreadSox) {
            var soxThreads = '0'
          } else {
            var soxThreads = '1'
          }
          if (resampling) {
            var conf8 = conf7.replace(
              '${sox}',
              'resampler {      ' +
                os.EOL +
                '  		plugin "soxr"' +
                os.EOL +
                '  		quality "' +
                resampling_quality +
                '"' +
                os.EOL +
                '  		threads "' +
                soxThreads +
                '"' +
                os.EOL +
                '}'
            )
            var conf9 = conf8.replace(
              '${format}',
              'format      "' + resampling_samplerate + ':' + resampling_bitdepth + ':2"'
            )
          } else {
            var conf8 = conf7.replace(
              '${sox}',
              'resampler {      ' +
                os.EOL +
                '  		plugin "soxr"' +
                os.EOL +
                '  		quality "high"' +
                os.EOL +
                '  		threads "' +
                soxThreads +
                '"' +
                os.EOL +
                '}'
            )
            var conf9 = conf8.replace('${format}', '')
          }
        }

        if (self.config.get('iso', false)) {
          // iso enabled
          var isopart =
            'decoder { ' +
            os.EOL +
            'plugin "sacdiso"' +
            os.EOL +
            'dstdec_threads "2"' +
            os.EOL +
            'edited_master "true"' +
            os.EOL +
            'lsbitfirst "false"' +
            os.EOL +
            'playable_area "stereo"' +
            os.EOL +
            '}' +
            os.EOL +
            'decoder { ' +
            os.EOL +
            'plugin "ffmpeg"' +
            os.EOL +
            'enabled "no"' +
            os.EOL +
            '}' +
            os.EOL
          var conf10 = conf9.replace('"${sacdiso}"', isopart)
          var conf11 = conf10.replace('${sox}', '')
        } else {
          // iso disabled
          var conf11 = conf9.replace('"${sacdiso}"', ' ')
        }

        if (ffmpeg) {
          var conf12 = conf11.replace(
            '"${ffmpeg}"',
            'decoder { ' +
              os.EOL +
              'plugin "ffmpeg"' +
              os.EOL +
              'enabled "yes"' +
              os.EOL +
              'analyzeduration "1000000000"' +
              os.EOL +
              'probesize "1000000000"' +
              os.EOL +
              '}' +
              os.EOL
          )
        } else {
          var conf12 = conf11.replace('"${ffmpeg}"', ' ')
        }

        for (var callback of self.registeredCallbacks) {
          var data = self.commandRouter.executeOnPlugin(callback.type, callback.plugin, callback.data)
          conf12 += data
        }

        var additionalConfs = self.getSpecialCardConfig()
        var specialSettings = ''
        if (additionalConfs && additionalConfs.length) {
          specialSettings = '### Device Special Settings'
          for (var i in additionalConfs) {
            specialSettings = specialSettings + os.EOL + '                ' + additionalConfs[i]
          }
        }
        var conf13 = conf12.replace('${special_settings}', specialSettings)

        fs.writeFile('/etc/mpd.conf', conf13, 'utf8', function (err) {
          if (err) {
            self.logger.info('Could not write mpd.conf:' + err)
          }
        })
      })

      callback()
    } catch (err) {
      callback(err)
    }
  }

  checkTrue(config) {
    var self = this
    var out = 'no'
    var value = self.config.get(config)

    if (value) {
      out = 'yes'
      return out
    } else {
      return out
    }
  }

  setConfiguration() {
    // DO something intelligent
  }

  getConfigParam(key) {
    var self = this
    var confval = self.config.get(key)
    return confval
  }

  setConfigParam(data) {
    var self = this

    self.config.set(data.key, data.value)
  }

  listPlaylists() {
    var self = this
    var defer = libQ.defer()
    var response = {
      navigation: {
        lists: [
          {
            availableListViews: ['list'],
            items: [],
          },
        ],
      },
    }
    if (singleBrowse) {
      response.navigation.prev = {uri: 'music-library'}
    }
    var promise = self.commandRouter.playListManager.listPlaylist()
    promise.then(function (data) {
      for (var i in data) {
        var ithdata = data[i]
        var playlist = {
          service: 'mpd',
          type: 'playlist',
          title: ithdata,
          icon: 'fa fa-list-ol',
          uri: 'playlists/' + ithdata,
        }
        response.navigation.lists[0].items.push(playlist)
      }

      defer.resolve(response)
    })

    return defer.promise
  }

  browsePlaylist(uri) {
    var self = this

    var defer = libQ.defer()
    var name = uri.split('/')[1]

    var response = {
      navigation: {
        lists: [
          {
            availableListViews: ['list'],
            items: [],
          },
        ],
        info: {
          uri: 'playlists/favourites',
          title: name,
          name: name,
          service: 'mpd',
          type: 'play-playlist',
          albumart: '/albumart?sourceicon=music_service/mpd/playlisticon.png',
        },
        prev: {
          uri: 'playlists',
        },
      },
    }

    var promise = self.commandRouter.playListManager.getPlaylistContent(name)
    promise.then(function (data) {
      var n = data.length
      for (var i = 0; i < n; i++) {
        var ithdata = data[i]
        var song = {
          service: ithdata.service,
          type: 'song',
          title: ithdata.title,
          artist: ithdata.artist,
          album: ithdata.album,
          albumart: ithdata.albumart,
          uri: ithdata.uri,
        }
        response.navigation.lists[0].items.push(song)
      }

      defer.resolve(response)
    })

    return defer.promise
  }

  lsInfo(uri) {
    var self = this

    var defer = libQ.defer()

    var sections = uri.split('/')
    var prev = ''
    var folderToList = ''
    var command = 'lsinfo'

    if (sections.length > 1) {
      prev = sections.slice(0, sections.length - 1).join('/')

      folderToList = sections.slice(1).join('/')
      var safeFolderToList = folderToList.replace(/"/g, '\\"')

      command += ' "' + safeFolderToList + '"'
    }

    var cmd = libMpd.cmd

    self.mpdReady
      .then(function () {
        self.clientMpd.sendCommand(cmd(command, []), function (err, msg) {
          var list = []
          if (singleBrowse && uri === 'music-library') {
            prev = '/'
            var browseSources = [
              {
                albumart: '/albumart?sourceicon=music_service/mpd/favouritesicon.png',
                title: self.commandRouter.getI18nString('COMMON.FAVOURITES'),
                uri: 'favourites',
                type: 'folder',
                disablePlayButton: true,
              },
              {
                albumart: '/albumart?sourceicon=music_service/mpd/playlisticon.png',
                title: self.commandRouter.getI18nString('COMMON.PLAYLISTS'),
                uri: 'playlists',
                type: 'folder',
                disablePlayButton: true,
              },
              {
                albumart: '/albumart?sourceicon=music_service/mpd/artisticon.png',
                title: self.commandRouter.getI18nString('COMMON.ARTISTS'),
                uri: 'artists://',
                type: 'folder',
                disablePlayButton: true,
              },
              {
                albumart: '/albumart?sourceicon=music_service/mpd/albumicon.png',
                title: self.commandRouter.getI18nString('COMMON.ALBUMS'),
                uri: 'albums://',
                type: 'folder',
                disablePlayButton: true,
              },
              {
                albumart: '/albumart?sourceicon=music_service/mpd/genreicon.png',
                title: self.commandRouter.getI18nString('COMMON.GENRES'),
                uri: 'genres://',
                type: 'folder',
                disablePlayButton: true,
              },
            ]

            for (const i in browseSources) {
              list.push(browseSources[i])
            }

            if (self.commandRouter.getPluginEnabled('music_service', 'upnp_browser')) {
              list.push({
                albumart: '/albumart?sourceicon=music_service/upnp_browser/dlnaicon.png',
                title: self.commandRouter.getI18nString('COMMON.MEDIA_SERVERS'),
                uri: 'upnp',
                type: 'folder',
                disablePlayButton: true,
              })
            }
          }
          if (uri === 'music-library' && stickingMusicLibrary) {
            var musicLibrary = [
              {
                albumart: self.getAlbumArt('', '', 'microchip'),
                title: 'INTERNAL',
                uri: 'music-library/INTERNAL',
                type: 'folder',
              },
              {
                albumart: self.getAlbumArt('', '', 'server'),
                title: 'NAS',
                uri: 'music-library/NAS',
                type: 'folder',
              },
              {
                albumart: self.getAlbumArt('', '', 'usb'),
                title: 'USB',
                uri: 'music-library/USB',
                type: 'folder',
              },
            ]

            for (const i in musicLibrary) {
              list.push(musicLibrary[i])
            }
          } else {
            if (msg) {
              const s0 = sections[0] + '/'
              const lines = msg.split('\n')
              for (let i = 0; i < lines.length; i++) {
                const line = lines[i]

                if (line.indexOf('directory:') === 0) {
                  const path = line.slice(11)
                  const namearr = path.split('/')
                  const name = namearr[namearr.length - 1]

                  // early out to exclude hidden folders (eg. ".Trashes")
                  if (name.startsWith('.')) {
                    continue
                  }

                  let albumart
                  if (uri === 'music-library') {
                    switch (path) {
                      case 'INTERNAL':
                        albumart = self.getAlbumArt('', '', 'microchip')
                        break
                      case 'NAS':
                        albumart = self.getAlbumArt('', '', 'server')
                        break
                      case 'USB':
                        albumart = self.getAlbumArt('', '', 'usb')
                        break
                      default:
                        albumart = self.getAlbumArt('', '/mnt/' + path, 'folder-o')
                    }
                  } else {
                    albumart = self.getAlbumArt('', '/mnt/' + path, 'folder-o')
                  }
                  let dirtype
                  if (namearr.length === 2 && namearr[0] === 'USB') {
                    dirtype = 'remdisk'
                  } else if (uri.indexOf('music-library/INTERNAL') >= 0) {
                    dirtype = 'internal-folder'
                  } else {
                    dirtype = 'folder'
                  }

                  list.push({
                    type: dirtype,
                    title: name,
                    service: 'mpd',
                    albumart: albumart,
                    uri: s0 + path,
                  })
                } else if (line.indexOf('playlist:') === 0) {
                  const path = line.slice(10)
                  const name = path.split('/').pop()
                  if (path.endsWith('.cue')) {
                    try {
                      var cuesheet = parser.parse('/mnt/' + path)

                      list.push({
                        service: 'mpd',
                        type: 'cuefile',
                        title: name,
                        icon: 'fa fa-list-ol',
                        uri: s0 + path,
                      })
                      var tracks = cuesheet.files[0].tracks
                      for (var j in tracks) {
                        list.push({
                          service: 'mpd',
                          type: 'cuesong',
                          title: tracks[j].title,
                          artist: tracks[j].performer,
                          album: path.substring(path.lastIndexOf('/') + 1),
                          number: tracks[j].number - 1,
                          icon: 'fa fa-music',
                          uri: s0 + path,
                        })
                      }
                    } catch (err) {
                      self.logger.error('Cue Parser - Cannot parse ' + path)
                    }
                  } else {
                    list.push({
                      service: 'mpd',
                      type: 'song',
                      title: name,
                      icon: 'fa fa-list-ol',
                      uri: s0 + path,
                    })
                  }
                } else if (line.indexOf('file:') === 0) {
                  const {path, artist, album, title, year, tracknumber, duration, genre} = parseMpdOutput(lines, i)
                  const albumart = self.getAlbumArt('', self.getParentFolder('/mnt/' + path), 'music')
                  list.push({
                    service: 'mpd',
                    type: 'song',
                    title,
                    artist,
                    album,
                    uri: s0 + path,
                    year,
                    albumart,
                    genre,
                    tracknumber,
                    duration,
                    composer: artist,
                  })
                }
              }
            } else {
              self.logger.error('Failed LSINFO: ' + err)
            }
          }
          defer.resolve({
            navigation: {
              prev: {
                uri: prev,
              },
              lists: [{availableListViews: ['grid', 'list'], items: list}],
            },
          })
        })
      })
      .fail(function (e) {
        self.logger.error('Could not execute lsinfo on URI: ' + uri + ' error: ' + e)
        defer.reject('')
      })
    return defer.promise
  }

  listallFolder(uri) {
    var self = this
    var defer = libQ.defer()
    var sections = uri.split('/')
    var prev = ''
    var command = 'listallinfo'
    var liburi = uri.slice(4)
    var cmd = libMpd.cmd

    self.mpdReady.then(function () {
      self.clientMpd.sendCommand(cmd(command, [liburi]), function (err, msg) {
        var list = []
        if (msg) {
          var s0 = sections[0] + '/'
          var lines = msg.split('\n')
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i]
            if (line.indexOf('file:') === 0) {
              const {path, albumartistOrArtist: artist, album, title} = parseMpdOutput(lines, i)
              var albumart = self.getAlbumArt(
                {artist: artist, album: album},
                self.getParentFolder('/mnt/' + path),
                'fa-tags'
              )
              list.push({
                service: 'mpd',
                type: 'song',
                title,
                artist,
                album,
                icon: 'fa fa-music',
                uri: s0 + path,
                albumart,
              })
            }
          }
        } else self.logger.error('Listall folder error: ' + err)

        defer.resolve({
          navigation: {
            prev: {
              uri: prev,
            },
            lists: [{availableListViews: ['list'], items: list}],
          },
        })
      })
    })
    return defer.promise
  }

  search(query) {
    var self = this
    var defer = libQ.defer()
    var safeValue = query.value.replace(/"/g, '\\"')

    var commandArtist = 'search artist ' + ' "' + safeValue + '"'
    var commandAlbum = 'search album ' + ' "' + safeValue + '"'
    var commandSong = 'search title ' + ' "' + safeValue + '"'
    var artistcount = 0
    var albumcount = 0
    var trackcount = 0
    var deferArray = []
    deferArray.push(libQ.defer())
    deferArray.push(libQ.defer())
    deferArray.push(libQ.defer())

    var cmd = libMpd.cmd
    // ARTIST
    self.mpdReady.then(function () {
      self.clientMpd.sendCommand(cmd(commandArtist, []), function (err, msg) {
        var subList = []
        if (msg) {
          var lines = msg.split('\n') // var lines is now an array
          var artistsfound = []
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i]
            if (line.startsWith('file:')) {
              const {artist} = parseMpdOutput(lines, i)
              if (artistsfound.indexOf(artist) < 0) {
                artistcount++
                artistsfound.push(artist)
                subList.push({
                  service: 'mpd',
                  type: 'folder',
                  title: artist,
                  uri: 'artists://' + encodeURIComponent(artist),
                  albumart: self.getAlbumArt({artist: artist}, undefined, 'users'),
                })
              }
            }
          }
          deferArray[0].resolve(subList)
        } else if (err) deferArray[0].reject(new Error('Artist:' + err))
        else deferArray[0].resolve()
      })
    })
    // ALBUM
    self.mpdReady.then(function () {
      self.clientMpd.sendCommand(cmd(commandAlbum, []), function (err, msg) {
        var subList = []

        if (msg) {
          var lines = msg.split('\n')
          var albumsfound = []
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i]
            if (line.startsWith('file:')) {
              const {path, albumartistOrArtist: artist, album} = parseMpdOutput(lines, i)
              if (album != undefined && artist != undefined && albumsfound.indexOf(album + artist) < 0) {
                albumcount++
                albumsfound.push(album + artist)
                subList.push({
                  service: 'mpd',
                  type: 'folder',
                  title: album,
                  artist,
                  album: '',
                  // Use the correct album / artist match
                  uri: 'albums://' + encodeURIComponent(artist) + '/' + encodeURIComponent(album),
                  albumart: self.getAlbumArt(
                    {artist: artist, album: album},
                    self.getParentFolder('/mnt/' + path),
                    'fa-tags'
                  ),
                })
              }
            }
          }
          deferArray[1].resolve(subList)
        } else if (err) deferArray[1].reject(new Error('Album:' + err))
        else deferArray[1].resolve()
      })
    })
    // SONG
    self.mpdReady.then(function () {
      self.clientMpd.sendCommand(cmd(commandSong, []), function (err, msg) {
        var subList = []
        if (msg) {
          var lines = msg.split('\n')
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i]
            if (line.startsWith('file:')) {
              trackcount++
              const {path, artist, album, title} = parseMpdOutput(lines, i)
              subList.push({
                service: 'mpd',
                type: 'song',
                title,
                artist,
                album,
                uri: 'music-library/' + path,
                albumart: self.getAlbumArt(
                  {artist: artist, album: album},
                  self.getParentFolder('/mnt/' + path),
                  'fa-tags'
                ),
              })
            }
          }
          deferArray[2].resolve(subList)
        } else if (err) deferArray[2].reject(new Error('Song:' + err))
        else deferArray[2].resolve()
      })
    })

    libQ
      .all(deferArray)
      .then(function (values) {
        var list = []

        if (values[0]) {
          var artistdesc = self.commandRouter.getI18nString('COMMON.ARTIST')
          if (artistcount > 1) artistdesc = self.commandRouter.getI18nString('COMMON.ARTISTS')
          list = [
            {
              title:
                self.commandRouter.getI18nString('COMMON.FOUND') +
                ' ' +
                artistcount +
                ' ' +
                artistdesc +
                " '" +
                query.value +
                "'",
              availableListViews: ['list', 'grid'],
              items: [],
            },
          ]

          list[0].items = list[0].items.concat(values[0])
        }

        if (values[1]) {
          var albumdesc = self.commandRouter.getI18nString('COMMON.ALBUM')
          if (albumcount > 1) albumdesc = self.commandRouter.getI18nString('COMMON.ALBUMS')
          var albList = {
            title:
              self.commandRouter.getI18nString('COMMON.FOUND') +
              ' ' +
              albumcount +
              ' ' +
              albumdesc +
              " '" +
              query.value +
              "'",
            availableListViews: ['list', 'grid'],
            items: [],
          }
          albList.items = values[1]

          list.push(albList)
        }

        if (values[2]) {
          var trackdesc = self.commandRouter.getI18nString(trackcount > 1 ? 'COMMON.TRACKS' : 'COMMON.TRACK')
          var songList = {
            title:
              self.commandRouter.getI18nString('COMMON.FOUND') +
              ' ' +
              trackcount +
              ' ' +
              trackdesc +
              " '" +
              query.value +
              "'",
            availableListViews: ['list'],
            items: [],
          }
          songList.items = values[2]

          list.push(songList)
        }

        list = list.filter(function (v) {
          return !!v === true
        })

        defer.resolve(list)
      })
      .fail(function (err) {
        self.commandRouter.logger.info('PARSING RESPONSE ERROR ' + err)

        defer.resolve()
      })
    return defer.promise
  }

  updateQueue() {
    var self = this

    var defer = libQ.defer()

    var prev = ''
    var command = 'playlistinfo'
    var list = []

    var cmd = libMpd.cmd
    self.mpdReady.then(function () {
      self.clientMpd.sendCommand(cmd(command, []), function (err, msg) {
        if (msg) {
          var lines = msg.split('\n')
          var queue = []
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i]
            if (line.indexOf('file:') === 0) {
              const {path, artist, album, title: rawtitle, position} = parseMpdOutput(lines, i)
              const queueItem = {
                uri: path,
                service: 'mpd',
                name: rawtitle || path.split('/').slice(-1)[0],
                artist: artist,
                album: album,
                type: 'track',
                tracknumber: position,
                albumart: self.getAlbumArt({artist: artist, album: album}, path),
              }
              queue.push(queueItem)
            }
          }
        } else self.logger.error('updateQueue error: ' + err)

        defer.resolve({
          navigation: {
            prev: {
              uri: prev,
            },
            list: list,
          },
        })
      })
    })

    return defer.promise
  }

  getAlbumArt(data, path, icon) {
    if (this.albumArtPlugin == undefined) {
      // initialization, skipped from second call
      this.albumArtPlugin = this.commandRouter.pluginManager.getPlugin('miscellanea', 'albumart')
    }

    if (this.albumArtPlugin) {
      return this.albumArtPlugin.getAlbumArt(data, path, icon)
    } else {
      return '/albumart'
    }
  }

  getAdditionalConf(type, controller, data, def) {
    var self = this
    var setting = self.commandRouter.executeOnPlugin(type, controller, 'getConfigParam', data)

    if (setting == undefined) {
      setting = def
    }

    return setting
  }

  rescanDb() {
    var self = this

    self.commandRouter.pushToastMessage(
      'success',
      self.commandRouter.getI18nString('COMMON.MY_MUSIC'),
      self.commandRouter.getI18nString('COMMON.RESCAN_DB')
    )
    return self.sendMpdCommand('rescan', [])
  }

  updateDb(data) {
    var self = this
    var pos = ''
    var message = self.commandRouter.getI18nString('COMMON.SCAN_DB')

    if (data != undefined) {
      pos = data.replace('music-library/', '')
      message = pos + ': ' + message
    }
    self.commandRouter.pushToastMessage('success', self.commandRouter.getI18nString('COMMON.MY_MUSIC'), message)
    return self.sendMpdCommand('update', [pos])
  }

  explodeUri(uri) {
    var self = this

    var defer = libQ.defer()
    var items = []
    var cmd = libMpd.cmd

    if (uri.startsWith('cue://')) {
      var splitted = uri.split('@')
      var index = splitted[1]
      var path = '/mnt/' + splitted[0].substring(6)

      var cuesheet = parser.parse(path)

      var tracks = cuesheet.files[0].tracks
      var cueartist = tracks[index].performer
      var cuealbum = cuesheet.title
      var cuenumber = tracks[index].number - 1
      var path = uri.substring(0, uri.lastIndexOf('/') + 1).replace('cue:/', '')

      defer.resolve({
        uri: uri,
        type: 'cuesong',
        service: 'mpd',
        name: tracks[index].title,
        artist: cueartist,
        album: cuealbum,
        number: cuenumber,
        albumart: self.getAlbumArt({artist: cueartist, album: cuealbum}, path),
      })
    } else if (uri.endsWith('.cue')) {
      try {
        var uriPath = '/mnt/' + self.sanitizeUri(uri)

        var cuesheet = parser.parse(uriPath)

        var tracks = cuesheet.files[0].tracks
        var list = []

        for (var j in tracks) {
          var cueItem = self.explodeCue(uriPath, j)
          list.push({
            uri: cueItem.uri,
            type: cueItem.type,
            service: cueItem.service,
            name: cueItem.name,
            artist: cueItem.artist,
            album: cueItem.album,
            number: cueItem.number,
            albumart: cueItem.albumart,
          })
        }

        defer.resolve(list)
      } catch (err) {
        self.logger.error(err)
        self.logger.error('Cue Parser - Cannot parse ' + uriPath)
      }
    } else if (uri.startsWith('search://')) {
      // exploding search
      var splitted = uri.split('/')
      var argument = splitted[2] // artist
      var value = splitted[3] // album
      var safeValue = value.replace(/"/g, '\\"')

      if (argument === 'artist') {
        var commandArtist = 'search artist ' + ' "' + safeValue + '"'

        self.mpdReady.then(function () {
          self.clientMpd.sendCommand(cmd(commandArtist, []), function (err, msg) {
            if (msg) {
              var lines = msg.split('\n')
              for (var i = 0; i < lines.length; i++) {
                var line = lines[i]

                if (line.startsWith('file:')) {
                  const {path, artist, album, title, duration} = parseMpdOutput(lines, i)
                  items.push({
                    uri: 'music-library/' + path,
                    service: 'mpd',
                    name: title,
                    artist,
                    album,
                    type: 'track',
                    tracknumber: 0,
                    albumart: self.getAlbumArt({artist: artist, album: album}, uri),
                    duration,
                    trackType: 'mp3',
                  })
                }
              }

              defer.resolve(items)
            } else if (err) defer.reject(new Error('Artist:' + err))
            else defer.resolve(items)
          })
        })
      } else if (argument === 'album') {
        if (compilation.indexOf(value) > -1) {
          // artist is in Various Artists array
          var commandArtist = 'search albumartist ' + ' "' + safeValue + '"'
        } else {
          var commandAlbum = 'search album ' + ' "' + safeValue + '"'
        }
        self.mpdReady.then(function () {
          self.clientMpd.sendCommand(cmd(commandAlbum, []), function (err, msg) {
            if (msg) {
              var lines = msg.split('\n')
              for (var i = 0; i < lines.length; i++) {
                var line = lines[i]
                if (line.startsWith('file:')) {
                  const {path, artist, album, title, duration} = parseMpdOutput(lines, i)
                  items.push({
                    uri: 'music-library/' + path,
                    service: 'mpd',
                    name: title,
                    artist,
                    album,
                    type: 'track',
                    tracknumber: 0,
                    albumart: self.getAlbumArt({artist: artist, album: album}, uri),
                    duration,
                    trackType: 'mp3',
                  })
                }
              }
              defer.resolve(items)
            } else if (err) defer.reject(new Error('Artist:' + err))
            else defer.resolve(items)
          })
        })
      } else defer.reject(new Error())
    } else if (uri.startsWith('albums://')) {
      // exploding search
      var splitted = uri.split('/')
      var artistName = decodeURIComponent(splitted[2])
      var albumName = decodeURIComponent(splitted[3])
      var cmd = libMpd.cmd
      // Escape any " within the strings used to construct the 'find' cmd
      var safeArtistName = artistName.replace(/"/g, '\\"')
      var safeAlbumName = albumName.replace(/"/g, '\\"')

      if (compilation.indexOf(artistName) > -1) {
        // artist is in Various Artists array or albumartist
        var GetAlbum = 'find album "' + safeAlbumName + '"' + ' albumartist "' + safeArtistName + '"'
      } else {
        // This section is commented beacuse, although correct it results in some albums not playing.
        // Until we find a better way to handle this we search just for album if there is no artist.
        if (safeArtistName !== null || safeArtistName !== '') {
          // is a artist ?
          var GetAlbum = 'find album "' + safeAlbumName + '"' + ' albumartist "' + safeArtistName + '"'
        } else {
          // No artist.
          var GetAlbum = 'find album "' + safeAlbumName + '"'
        }
      }

      self.clientMpd.sendCommand(cmd(GetAlbum, []), function (err, msg) {
        var list = []
        if (msg) {
          var lines = msg.split('\n')
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i]
            if (line.indexOf('file:') === 0) {
              const {path, artist, album, title, duration} = parseMpdOutput(lines, i)
              var albumart = self.getAlbumArt(
                {artist: artist, album: album, icon: 'dot-circle-o'},
                self.getParentFolder('/mnt/' + path)
              )
              list.push({
                uri: 'music-library/' + path,
                service: 'mpd',
                name: title,
                artist,
                album,
                type: 'track',
                tracknumber: 0,
                albumart,
                duration,
                trackType: path.split('.').pop(),
              })
            }
          }
        } else self.logger.error('Explode URI Error: ' + err)

        defer.resolve(list)
      })
    } else if (uri.startsWith('artists://')) {
      /*
           artists://AC%2FDC/Rock%20or%20Bust in service mpd
           */
      var splitted = uri.split('/')

      if (splitted.length === 4) {
        return this.explodeUri('albums://' + splitted[2] + '/' + splitted[3])
      }
      var artist = decodeURIComponent(splitted[2])

      var cmd = libMpd.cmd

      var safeArtist = artist.replace(/"/g, '\\"')
      self.clientMpd.sendCommand(cmd('find artist "' + safeArtist + '"', []), function (err, msg) {
        if (msg == '') {
          self.clientMpd.sendCommand(cmd('find albumartist "' + safeArtist + '"', []), function (err, msg) {
            self.exploderArtist(err, msg, defer)
          })
        } else self.exploderArtist(err, msg, defer)
      })
    } else if (uri.startsWith('genres://')) {
      // exploding search
      var splitted = uri.split('/')
      var genreName = decodeURIComponent(splitted[2])
      var artistName = decodeURIComponent(splitted[3])
      var albumName = decodeURIComponent(splitted[4])
      // Escape any " within the strings used to construct the 'find' cmd
      var safeGenreName = genreName.replace(/"/g, '\\"')
      var safeArtistName = artistName.replace(/"/g, '\\"')
      var safeAlbumName = albumName.replace(/"/g, '\\"')

      if (splitted.length == 4) {
        if (artistsort) {
          var GetMatches = 'find genre "' + safeGenreName + '" albumartist "' + safeArtistName + '"'
        } else {
          var GetMatches = 'find genre "' + safeGenreName + '" artist "' + safeArtistName + '"'
        }
      } else if (splitted.length == 5) {
        if (compilation.indexOf(artistName) > -1) {
          // artist is in compilation array so only find album
          var GetMatches = 'find genre "' + safeGenreName + '" album "' + safeAlbumName + '"'
        } else {
          // artist is NOT in compilation array so use artist
          if (artistsort) {
            var GetMatches =
              'find genre "' + safeGenreName + '" albumartist "' + safeArtistName + '" album "' + safeAlbumName + '"'
          } else {
            var GetMatches =
              'find genre "' + safeGenreName + '" artist "' + safeArtistName + '" album "' + safeAlbumName + '"'
          }
        }
      } else {
        var GetMatches = 'find genre "' + safeGenreName + '"'
      }

      var cmd = libMpd.cmd

      self.clientMpd.sendCommand(cmd(GetMatches, []), function (err, msg) {
        var list = []
        if (msg) {
          var lines = msg.split('\n')
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i]
            if (line.indexOf('file:') === 0) {
              const {path, artist, album, title, duration} = parseMpdOutput(lines, i)
              var albumart = self.getAlbumArt({artist: artist, album: album}, self.getParentFolder('/mnt/' + path))
              if (title !== '') {
                list.push({
                  uri: 'music-library/' + path,
                  service: 'mpd',
                  name: title,
                  artist,
                  album,
                  type: 'track',
                  tracknumber: 0,
                  albumart: albumart,
                  duration,
                  trackType: path.split('.').pop(),
                })
              }
            }
          }

          defer.resolve(list)
        } else {
          self.logger.info(err)
          defer.reject(new Error())
        }
      })
    } else if (uri.endsWith('.iso')) {
      var uriPath = '/mnt/' + self.sanitizeUri(uri)

      var uris = self.scanFolder(uriPath)
      var response = []

      libQ.all(uris).then(function (result) {
        // IF we need to explode the whole iso file
        if (Array.isArray(result)) {
          result = result[0]
          defer.resolve(result)
        } else {
          for (var j in result) {
            // self.commandRouter.logger.info("----->>>>> " + JSON.stringify(result[j]));
            // console.log('AAAAAAAAALLLLLLLLLLLLLLLLLLLLL'+result[j].albumart)
            var albumartiso = result[j].albumart.substring(0, result[j].albumart.lastIndexOf('%2F'))
            if (result !== undefined && result[j].uri !== undefined) {
              response.push({
                uri: self.fromPathToUri(result[j].uri),
                service: 'mpd',
                name: result[j].name,
                artist: result[j].artist,
                album: result[j].album,
                type: 'track',
                tracknumber: result[j].tracknumber,
                albumart: albumartiso,
                duration: result[j].duration,
                samplerate: result[j].samplerate,
                bitdepth: result[j].bitdepth,
                trackType: result[j].trackType,
              })
            }
          }
          defer.resolve(response)
        }
      })
    } else {
      var uriPath = '/mnt/' + self.sanitizeUri(uri)
      // self.commandRouter.logger.info('----------------------------'+uriPath);
      var uris = self.scanFolder(uriPath)
      var response = []

      libQ
        .all(uris)
        .then(function (result) {
          for (var j in result) {
            // self.commandRouter.logger.info("----->>>>> "+JSON.stringify(result[j]));

            if (result !== undefined && result[j].uri !== undefined) {
              response.push({
                uri: self.fromPathToUri(result[j].uri),
                service: 'mpd',
                name: result[j].name,
                artist: result[j].artist,
                album: result[j].album,
                type: 'track',
                tracknumber: result[j].tracknumber,
                albumart: result[j].albumart,
                duration: result[j].duration,
                samplerate: result[j].samplerate,
                bitdepth: result[j].bitdepth,
                trackType: result[j].trackType,
                year: result[j].year,
              })
            }
          }
          defer.resolve(response)
        })
        .fail(function (err) {
          self.commandRouter.logger.info('explodeURI: ERROR ' + err)
          defer.resolve([])
        })
    }

    return defer.promise
  }

  explodeCue(uri, index) {
    var self = this
    var uri = self.sanitizeUri(uri)
    var cuesheet = parser.parse('/mnt/' + uri)
    var cuealbum
    var cueartist
    var cuename
    var tracks = cuesheet.files[0].tracks

    if (cuesheet.title != undefined && cuesheet.title.length > 0) {
      cuealbum = cuesheet.title
    } else {
      cuealbum = uri.substring(uri.lastIndexOf('/') + 1)
    }

    if (tracks[index].performer != undefined && tracks[index].performer.length > 0) {
      cueartist = tracks[index].performer
    } else {
      cueartist = cuesheet.files[0].performer
    }
    var cuename = tracks[index].title
    var cueuri = 'cue://' + uri + '@' + index

    var cueItem = {
      uri: cueuri.replace('///', '//'),
      service: 'mpd',
      name: cuename,
      artist: cueartist,
      album: cuealbum,
      number: Number(index) + 1,
      albumart: self.getAlbumArt({artist: cueartist, album: cuealbum}, self.getParentFolder('/mnt/' + uri)),
    }

    return cueItem
  }

  exploderArtist(err, msg, defer) {
    var self = this
    var list = []
    if (msg) {
      var lines = msg.split('\n')
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i]
        if (line.indexOf('file:') === 0) {
          const {path, artist, album, title, duration} = parseMpdOutput(lines, i)
          var albumart = self.getAlbumArt({artist: artist, album: album}, self.getParentFolder('/mnt/' + path))
          list.push({
            uri: 'music-library/' + path,
            service: 'mpd',
            name: title,
            artist,
            album,
            type: 'track',
            tracknumber: 0,
            albumart,
            duration,
            trackType: path.split('.').pop(),
          })
        }
      }

      defer.resolve(list)
    } else {
      self.logger.error('Explode uri error: ' + err)
      defer.reject(new Error())
    }
  }

  fromUriToPath(uri) {
    var sections = uri.split('/')
    var prev = ''

    if (sections.length > 1) {
      prev = sections.slice(1, sections.length).join('/')
    }
    return prev
  }

  fromPathToUri(uri) {
    var sections = uri.split('/')
    var prev = ''

    if (sections.length > 1) {
      prev = sections.slice(1, sections.length).join('/')
    }
    return prev
  }

  scanFolder(uri) {
    var self = this
    var uris = []
    var isofile = false

    if (uri.indexOf('.iso') >= 0 || uri.indexOf('.ISO') >= 0) {
      var uri2 = uri.substr(0, uri.lastIndexOf('/'))
      if (uri2.indexOf('.iso') < 0 && uri2.indexOf('.ISO') < 0) {
        isofile = true
      }
    } else {
      try {
        var stat = libFsExtra.statSync(uri)
      } catch (err) {
        self.logger.error("scanFolder - failure to stat '" + uri + "'")
        return uris
      }
    }

    if (uri.indexOf('.iso') < 0 && uri.indexOf('.ISO') < 0 && stat != undefined && stat.isDirectory()) {
      try {
        var files = libFsExtra.readdirSync(uri)
        for (var i in files) {
          uris = uris.concat(self.scanFolder(uri + '/' + files[i]))
        }
      } catch (e) {
        self.logger.error("Failed to stat '" + uri + "'")
      }
    } else if (isofile) {
      var defer = libQ.defer()
      var uris = self.explodeISOFile(uri)
      defer.resolve(uris)
      return defer.promise
    } else {
      var defer = libQ.defer()

      var sections = uri.split('/')
      var folderToList = ''
      var command = 'lsinfo'

      if (sections.length > 1) {
        folderToList = sections.slice(2).join('/')

        var safeFolderToList = folderToList.replace(/"/g, '\\"')
        command += ' "' + safeFolderToList + '"'
      }

      var cmd = libMpd.cmd

      self.mpdReady.then(function () {
        self.clientMpd.sendCommand(cmd(command, []), function (err, msg) {
          if (msg) {
            var lines = msg.split('\n')
            var isSolved = false

            for (var i = 0; i < lines.length; i++) {
              var line = lines[i]
              if (line.indexOf('file:') === 0) {
                const {artist, album, title, duration, year, tracknumber} = parseMpdOutput(lines, i)
                self.commandRouter.logger.info('URI ' + uri)
                self.commandRouter.logger.info('ALBUMART ' + self.getAlbumArt({artist: artist, album: album}, uri))
                defer.resolve({
                  uri: 'music-library/' + self.fromPathToUri(uri),
                  service: 'mpd',
                  name: title,
                  artist,
                  album,
                  type: 'track',
                  tracknumber,
                  albumart: self.getAlbumArt({artist: artist, album: album}, self.getAlbumArtPathFromUri(uri)),
                  duration,
                  trackType: uri.split('.').pop(),
                  year,
                })

                isSolved = true
              }
            }

            if (isSolved === false) {
              defer.resolve({})
            }
          } else defer.resolve({})
        })
      })

      return defer.promise
    }

    return uris
  }

  explodeISOFile(uri) {
    var self = this

    var defer = libQ.defer()
    var sections = uri.split('/')
    var folderToList = ''
    var command = 'lsinfo'
    var ISOlist = []

    if (sections.length > 1) {
      folderToList = sections.slice(2).join('/')

      var safeFolderToList = folderToList.replace(/"/g, '\\"')
      command += ' "' + safeFolderToList + '"'
    }

    var cmd = libMpd.cmd

    self.mpdReady.then(function () {
      self.clientMpd.sendCommand(cmd(command, []), function (err, msg) {
        if (msg) {
          var lines = msg.split('\n')
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i]

            if (line.indexOf('file:') === 0) {
              const {path, artist, album, title, duration} = parseMpdOutput(lines, i)
              self.commandRouter.logger.info('URI ' + uri)
              self.commandRouter.logger.info(
                'ALBUMART ' +
                  self.getAlbumArt(
                    {
                      artist: artist,
                      album: album,
                    },
                    uri
                  )
              )
              ISOlist.push({
                uri: path,
                service: 'mpd',
                name: title,
                artist,
                album,
                type: 'track',
                tracknumber: 0,
                albumart: self.getAlbumArt(
                  {
                    artist,
                    album,
                  },
                  self.getAlbumArtPathFromUri(uri)
                ),
                duration,
                samplerate: '',
                bitdepth: '',
                trackType: uri.split('.').pop(),
              })
            }
          }
          defer.resolve(ISOlist)
        } else {
          defer.resolve([])
        }
      })
    })

    return defer.promise
  }

  clearAddPlayTrack(track) {
    var self = this
    if (track.uri.startsWith('cue://')) {
      var uri1 = track.uri.substring(6)
      var splitted = uri1.split('@')

      var index = splitted[1]
      var uri = self.sanitizeUri(splitted[0])
      var safeUri = uri.replace(/"/g, '\\"')

      return self
        .sendMpdCommand('stop', [])
        .then(function () {
          return self.sendMpdCommand('clear', [])
        })
        .then(function () {
          return self.sendMpdCommand('load "' + safeUri + '"', [])
        })
        .then(function () {
          return self.sendMpdCommand('play', [index])
        })
    } else {
      var uri = self.sanitizeUri(track.uri)

      self.logger.verbose('ControllerMpd::clearAddPlayTracks ' + uri)

      var urilow = uri.toLowerCase()
      if (urilow.endsWith('.dff') || urilow.endsWith('.dsd') || urilow.endsWith('.dxd') || urilow.endsWith('.dsf')) {
        self.dsdVolume()
      }
      // Clear the queue, add the first track, and start playback
      var safeUri = uri.replace(/"/g, '\\"')

      return self
        .sendMpdCommand('stop', [])
        .then(function () {
          return self.sendMpdCommand('clear', [])
        })
        .then(function () {
          return self.sendMpdCommand('add "' + safeUri + '"', [])
        })
        .then(function () {
          return self.sendMpdCommand('play', [])
        })
    }
  }

  seek(position) {
    var self = this
    self.logger.info('ControllerMpd::seek')

    var defer = libQ.defer()
    var command = 'seek '
    var cmd = libMpd.cmd

    if (self.clientMpd !== undefined) {
      self.clientMpd.sendCommand(cmd(command, ['0', position / 1000]), function (err, msg) {
        if (msg) {
          self.logger.info(msg)
        } else self.logger.error(err)

        defer.resolve()
      })
    } else {
      self.logger.error('Could not seek because there is no mpd connection')
    }

    return defer.promise
  }

  pause() {
    this.logger.info('ControllerMpd::pause')
    return this.sendMpdCommand('pause', [])
  }

  resume() {
    this.logger.info('ControllerMpd::resume')
    return this.sendMpdCommand('play', [])
  }

  stop() {
    this.logger.info('ControllerMpd::stop')
    return this.sendMpdCommand('stop', [])
  }

  sanitizeUri(uri) {
    return uri.replace('music-library/', '').replace('mnt/', '')
  }

  reportUpdatedLibrary() {
    var self = this
    // TODO PUSH THIS MESSAGE TO ALL CONNECTED CLIENTS
    self.logger.info('ControllerMpd::DB Update Finished')
    return self.commandRouter.pushToastMessage('Success', 'ASF', ' Added')
  }

  getConfigurationFiles() {
    return ['config.json']
  }

  setAdditionalConf(type, controller, data) {
    var self = this
    return self.commandRouter.executeOnPlugin(type, controller, 'setConfigParam', data)
  }

  getMyCollectionStats() {
    var self = this

    var defer = libQ.defer()

    try {
      var cmd = libMpd.cmd
      self.clientMpd.sendCommand(cmd('count', ['group', 'artist']), function (err, msg) {
        if (err) {
          defer.resolve({
            artists: 0,
            albums: 0,
            songs: 0,
            playtime: '00:00:00',
          })
        } else {
          var artistsCount = 0
          var songsCount = 0
          var playtimesCount = 0

          var splitted = msg.split('\n')
          for (var i = 0; i < splitted.length - 1; i = i + 3) {
            artistsCount++
            songsCount = songsCount + parseInt(splitted[i + 1].substring(7))
            playtimesCount = playtimesCount + parseInt(splitted[i + 2].substring(10))
          }

          try {
            var hours = Math.floor(playtimesCount / 3600)
            var minutes = Math.floor(playtimesCount / 60) - hours * 60
            var seconds = Math.floor(playtimesCount - hours * 3600 - minutes * 60)
            var playTimeString = hours + ':' + minutes + ':' + seconds
          } catch (e) {
            var playTimeString = '0:0:0'
          }

          self.clientMpd.sendCommand(cmd('list', ['album', 'group', 'albumartist']), function (err, msg) {
            if (!err) {
              var splittedAlbum = msg.split('\n')
              var albumsCount = 0
              for (var i = 0; i < splittedAlbum.length; i++) {
                var line = splittedAlbum[i]
                if (line.startsWith('Album:')) {
                  albumsCount++
                }
              }
              var response = {
                artists: artistsCount,
                albums: albumsCount,
                songs: songsCount,
                playtime: playTimeString,
              }
            }

            defer.resolve(response)
          })
        }
      })
    } catch (e) {
      defer.resolve('')
    }

    return defer.promise
  }

  getGroupVolume() {
    var self = this
    var defer = libQ.defer()

    self.sendMpdCommand('status', []).then(function (objState) {
      if (objState.volume) {
        defer.resolve(objState.volume)
      }
    })
    return defer.promise
  }

  setGroupVolume(data) {
    var self = this
    return self.sendMpdCommand('setvol', [data])
  }

  syncGroupVolume() {}

  handleBrowseUri(curUri) {
    var self = this
    var response

    self.logger.info('CURURI: ' + curUri)
    var splitted = curUri.split('/')

    // music-library
    if (curUri.startsWith('music-library')) {
      response = self.lsInfo(curUri)
    }

    // playlist
    else if (curUri.startsWith('playlists')) {
      if (curUri === 'playlists') {
        response = self.listPlaylists(curUri)
      } else {
        response = self.browsePlaylist(curUri)
      }
    }

    // albums
    else if (curUri.startsWith('albums://')) {
      if (curUri === 'albums://') {
        // Just list albums
        response = self.listAlbums(curUri)
      } else {
        if (splitted.length == 3) {
          response = self.listAlbumSongs(curUri, 2, 'albums://')
        } else {
          response = self.listAlbumSongs(curUri, 3, 'albums://')
        }
      }
    }

    // artists
    else if (curUri.startsWith('artists://')) {
      if (curUri === 'artists://') {
        response = self.listArtists(curUri)
      } else {
        if (splitted.length === 3) {
          // No album name
          response = self.listArtist(curUri, 2, 'artists://', 'artists://') // Pass back to listArtist
        } else {
          // Has album name
          response = self.listAlbumSongs(curUri, 3, 'artists://' + splitted[2]) // Pass to listAlbumSongs with artist and album name
        }
      }
    }

    // genres
    else if (curUri.startsWith('genres://')) {
      if (curUri === 'genres://') {
        response = self.listGenres(curUri)
      } else {
        if (splitted.length == 3) {
          response = self.listGenre(curUri)
        } else if (splitted.length == 4) {
          response = self.listArtist(curUri, 3, 'genres://' + splitted[2], 'genres://')
        } else if (splitted.length == 5) {
          response = self.listAlbumSongs(curUri, 4, 'genres://' + splitted[2])
        } else if (splitted.length == 6) {
          response = self.listAlbumSongs(curUri, 4, 'genres://' + splitted[4] + '/' + splitted[5])
        }
      }
    }

    return response
  }

  listAlbums(ui) {
    var self = this

    var defer = libQ.defer()
    memoryCache.get('cacheAlbumList', function (err, response) {
      if (response == undefined) {
        response = {
          navigation: {
            lists: [
              {
                availableListViews: ['list', 'grid'],
                items: [],
              },
            ],
          },
        }
        if (singleBrowse) {
          response.navigation.prev = {uri: 'music-library'}
        }
        var cmd = libMpd.cmd

        self.clientMpd.sendCommand(cmd('search album ""', []), function (err, msg) {
          if (err) {
            defer.reject(new Error('Cannot list albums'))
          } else {
            var lines = msg.split('\n')
            var albumsfound = []
            for (var i = 0; i < lines.length; i++) {
              var line = lines[i]
              if (line.startsWith('file:')) {
                const {path, album, year: albumYear, albumartistOrArtist} = parseMpdOutput(lines, i)
                let albumName = album
                let artistName = albumartistOrArtist

                // This causes all orphaned tracks (tracks without an album) in the Albums view to be
                //  grouped into a single dummy-album, rather than creating one such dummy-album per artist.
                var albumId = albumName + artistName
                if (!albumName) {
                  albumId = ''
                  albumName = ''
                  artistName = '*'
                }
                // Check if album and artist combination is already found and exists in 'albumsfound' array (Allows for duplicate album names)
                if (albumsfound.indexOf(albumId) < 0) {
                  // Album/Artist is not in 'albumsfound' array
                  albumsfound.push(albumId)
                  const item = {
                    service: 'mpd',
                    type: 'folder',
                    title: albumName,
                    artist: artistName,
                    year: albumYear,
                    album: '',
                    uri: 'albums://' + encodeURIComponent(artistName) + '/' + encodeURIComponent(albumName),
                    // Get correct album art from path- only download if not existent
                    albumart: self.getAlbumArt(
                      {artist: artistName, album: albumName},
                      self.getParentFolder('/mnt/' + path),
                      'dot-circle-o'
                    ),
                  }
                  response.navigation.lists[0].items.push(item)
                }
              }
            }
            // Save response in albumList cache for future use
            memoryCache.set('cacheAlbumList', response)
            if (ui) {
              defer.resolve(response)
            }
          }
        })
      } else {
        self.logger.info('listAlbums - loading Albums from cache')
        if (ui) {
          defer.resolve(response)
        }
      }
    })
    return defer.promise
  }

  listAlbumSongs(uri, index, previous) {
    var self = this
    var defer = libQ.defer()
    var splitted = uri.split('/')

    if (splitted[0] === 'genres:') {
      // genre
      const genre = decodeURIComponent(splitted[2])
      const artist = decodeURIComponent(splitted[3])
      var albumName = decodeURIComponent(splitted[4])
      var safeGenre = genre.replace(/"/g, '\\"')
      var safeArtist = artist.replace(/"/g, '\\"')
      var safeAlbumName = albumName.replace(/"/g, '\\"')

      if (compilation.indexOf(artist) > -1) {
        var findstring = 'find album "' + safeAlbumName + '" genre "' + safeGenre + '" '
      } else if (artistsort) {
        var findstring =
          'find album "' + safeAlbumName + '" albumartist "' + safeArtist + '" genre "' + safeGenre + '" '
      } else {
        var findstring = 'find album "' + safeAlbumName + '" artist "' + safeArtist + '" genre "' + safeGenre + '" '
      }
    } else if (splitted[0] == 'albums:') {
      // album
      const artist = decodeURIComponent(splitted[2])
      var albumName = decodeURIComponent(splitted[3])
      var safeArtist = artist.replace(/"/g, '\\"')
      var safeAlbumName = albumName.replace(/"/g, '\\"')

      var isOrphanAlbum = uri === 'albums://*/'
      var artistSubQuery = isOrphanAlbum ? '' : ' albumartist "' + safeArtist + '" '

      var findstring = 'find album "' + safeAlbumName + '"' + artistSubQuery
    } else {
      // artist
      const artist = decodeURIComponent(splitted[2])
      var albumName = decodeURIComponent(splitted[3])
      var safeArtist = artist.replace(/"/g, '\\"')
      var safeAlbumName = albumName.replace(/"/g, '\\"')

      /* This section is commented because we should use albumartist: if albumartist tag does not exist, it will fallback to artist
           if (compilation.indexOf(artist)>-1) {       //artist is in compilation array so use albumartist
           var typeofartist = 'albumartist';
           }
           else {                                      //artist is NOT in compilation array so use artist
           var typeofartist = 'artist';
           }
           */
      var typeofartist = 'albumartist'
      var findstring = 'find album "' + safeAlbumName + '" ' + typeofartist + ' "' + safeArtist + '" '
    }
    var response = {
      navigation: {
        info: {
          uri: 'music-library/',
          service: 'mpd',
          title: 'title',
          artist: 'artist',
          album: 'album',
          type: 'song',
          albumart: 'albumart',
          duration: 'time',
        },
        lists: [
          {
            availableListViews: ['list'],
            items: [],
          },
        ],
        prev: {
          uri: previous,
        },
      },
    }

    var cmd = libMpd.cmd
    var totalDuration = 0
    let respTrackType = ''
    let respArtist
    let respAlbum
    let respYear
    let respGenre

    self.clientMpd.sendCommand(cmd(findstring, []), function (err, msg) {
      if (msg) {
        var lines = msg.split('\n')
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i]
          if (line.indexOf('file:') === 0) {
            const {path, artist, album, title, year, tracknumber, duration, genre} = parseMpdOutput(lines, i)
            var albumart = self.getAlbumArt({artist: artist, album: album}, self.getParentFolder(path), 'dot-circle-o')
            var trackType = path.split('.').pop()
            totalDuration = totalDuration + duration
            respTrackType = trackType
            respArtist = artist
            respAlbum = album
            respYear = year
            respGenre = genre
            response.navigation.lists[0].items.push({
              uri: 'music-library/' + path,
              service: 'mpd',
              title,
              artist,
              album,
              type: 'song',
              tracknumber,
              duration,
              trackType,
            })
          }
        }
        if (totalDuration && totalDuration > 0) {
          var durationminutes = Math.floor(totalDuration / 60)
          var durationseconds = totalDuration - durationminutes * 60
          if (durationseconds < 10) {
            durationseconds = '0' + durationseconds
          }
          totalDuration = durationminutes + ':' + durationseconds
        }
        var isOrphanAlbum = uri === 'albums://*/'
        response.navigation.info = {
          uri,
          service: 'mpd',
          artist: isOrphanAlbum ? '*' : respArtist,
          album: respAlbum,
          albumart,
          year: isOrphanAlbum ? '' : respYear,
          genre: isOrphanAlbum ? '' : respGenre,
          type: 'album',
          trackType: respTrackType,
          duration: totalDuration,
        }
      } else self.logger.error('Listalbum songs error: ' + err)

      defer.resolve(response)
    })

    return defer.promise
  }

  listArtists() {
    var self = this

    var defer = libQ.defer()

    var response = {
      navigation: {
        lists: [
          {
            availableListViews: ['list', 'grid'],
            items: [],
          },
        ],
      },
    }
    if (singleBrowse) {
      response.navigation.prev = {uri: 'music-library'}
    }

    var cmd = libMpd.cmd
    var artistlist = 'artist'
    var artistbegin = 'Artist: '

    if (artistsort) {
      artistlist = 'albumartist'
      artistbegin = 'AlbumArtist: '
    }

    self.clientMpd.sendCommand(cmd('list', [artistlist]), function (err, msg) {
      // List artists
      if (err) {
        defer.reject(new Error('Cannot list artist'))
      } else {
        var splitted = msg.split('\n')

        for (var i in splitted) {
          if (splitted[i].startsWith(artistbegin)) {
            var artist = splitted[i].substring(artistbegin.length)

            if (artist !== '') {
              var codedArtists = encodeURIComponent(artist)
              var albumart = self.getAlbumArt({artist: codedArtists}, undefined, 'users')
              var item = {
                service: 'mpd',
                type: 'folder',
                title: artist,
                albumart: albumart,
                uri: 'artists://' + codedArtists,
              }

              response.navigation.lists[0].items.push(item)
            }
          }
        }
        defer.resolve(response)
      }
    })
    return defer.promise
  }

  listArtist(curUri, index, previous, uriBegin) {
    var self = this

    var defer = libQ.defer()

    var splitted = curUri.split('/')
    var albumart = self.getAlbumArt({artist: decodeURIComponent(splitted[index])}, undefined, 'users')

    var response = {
      navigation: {
        lists: [
          {
            title: self.commandRouter.getI18nString('COMMON.ALBUMS') + ' (' + decodeURIComponent(splitted[index]) + ')',
            icon: 'fa icon',
            availableListViews: ['list', 'grid'],
            items: [],
          },
          {
            title: self.commandRouter.getI18nString('COMMON.TRACKS') + ' (' + decodeURIComponent(splitted[index]) + ')',
            icon: 'fa icon',
            availableListViews: ['list'],
            items: [],
          },
        ],
        prev: {
          uri: previous,
        },
        info: {
          uri: curUri,
          title: decodeURIComponent(splitted[index]),
          service: 'mpd',
          type: 'artist',
          albumart: albumart,
        },
      },
    }

    self.mpdReady.then(function () {
      let artist = decodeURIComponent(splitted[index])
      var VA = 0
      var cmd = libMpd.cmd
      var safeArtist = artist.replace(/"/g, '\\"')
      let findartist

      if (uriBegin === 'genres://') {
        try {
          var genreString = curUri.replace('genres://', '')
          var genre = decodeURIComponent(genreString.split('/')[0])
          var safeGenre = genre.replace(/"/g, '\\"')
          artist = decodeURIComponent(genreString.split('/')[1])
          safeArtist = artist.replace(/"/g, '\\"')
        } catch (e) {
          self.logger.error('Cannot browse genre: ' + e)
        }
        if (artistsort) {
          findartist = 'find albumartist "' + safeArtist + '" genre "' + safeGenre + '" '
        } else {
          findartist = 'find artist "' + safeArtist + '" genre "' + safeGenre + '" '
        }
      } else {
        if (compilation.indexOf(artist) > -1) {
          // artist is in compilation array so use albumartist
          findartist = 'find albumartist "' + safeArtist + '"'
          VA = 1
        } else {
          // artist is NOT in compilation array so use artist or albumartist
          if (artistsort) {
            // Fix - now set by artistsort variable
            findartist = 'find albumartist "' + safeArtist + '"'
          } else {
            findartist = 'find artist "' + safeArtist + '"'
          }
        }
      }

      self.clientMpd.sendCommand(cmd(findartist, []), function (err, msg) {
        // get data (msg)
        if (msg == '') {
          // If there is no data (msg) get data first, else just parseListAlbum
          self.clientMpd.sendCommand(cmd(findartist, []), function (err, msg) {
            self.parseListAlbum(err, msg, defer, response, uriBegin, VA)
          })
        } else {
          self.parseListAlbum(err, msg, defer, response, uriBegin, VA)
        }
      })
    })

    return defer.promise
  }

  parseListAlbum(err, msg, defer, response, uriBegin) {
    var self = this
    var albums = []
    if (msg) {
      var lines = msg.split('\n')
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i]
        if (line.indexOf('file:') === 0) {
          const {path, albumartistOrArtist: artist, album, title, year, genre} = parseMpdOutput(lines, i)
          var albumart = self.getAlbumArt({artist: artist, album: album}, self.getParentFolder(path), 'dot-circle-o')
          response.navigation.lists[1].items.push({
            service: 'mpd',
            type: 'song',
            title,
            artist,
            album,
            year,
            albumart,
            uri: 'music-library/' + path,
          })

          // The first expression in the following "if" statement prevents dummy-albums from being
          //  created for orphaned tracks (tracks without an album). Such dummy-albums aren't required,
          //  as orphaned tracks remain accessible from the tracks-list.
          if (album !== '' && albums.indexOf(album) === -1) {
            albums.push(album)
            var uri

            if (uriBegin === 'artists://') {
              uri = 'artists://' + encodeURIComponent(artist) + '/' + encodeURIComponent(album)
            } else if (uriBegin === 'genres://') {
              uri =
                'genres://' +
                encodeURIComponent(genre) +
                '/' +
                encodeURIComponent(artist) +
                '/' +
                encodeURIComponent(album)
            } else {
              uri = uriBegin + encodeURIComponent(album)
            }

            response.navigation.lists[0].items.push({
              service: 'mpd',
              type: 'folder',
              title: album,
              artist,
              albumart: self.getAlbumArt({artist: artist, album: album}, self.getParentFolder(path), 'dot-circle-o'),
              uri,
            })
          }
        }
      }

      defer.resolve(response)
    } else {
      self.logger.error('Parse List Albums error:' + err)
      defer.reject(new Error())
    }
  }

  listGenres() {
    var self = this
    var defer = libQ.defer()
    var response = {
      navigation: {
        lists: [
          {
            availableListViews: ['list'],
            items: [],
          },
        ],
      },
    }
    if (singleBrowse) {
      response.navigation.prev = {uri: 'music-library'}
    }

    var cmd = libMpd.cmd
    self.clientMpd.sendCommand(cmd('list', ['genre']), function (err, msg) {
      if (err) {
        defer.reject(new Error('Cannot list genres'))
      } else {
        var splitted = msg.split('\n')

        for (var i in splitted) {
          if (splitted[i].startsWith('Genre:')) {
            var genreName = splitted[i].substring(7)

            if (genreName !== '') {
              var albumart = self.getAlbumArt({}, undefined, 'fa-tags')
              var album = {
                service: 'mpd',
                type: 'folder',
                title: genreName,
                albumart: albumart,
                uri: 'genres://' + encodeURIComponent(genreName),
              }

              response.navigation.lists[0].items.push(album)
            }
          }
        }
        defer.resolve(response)
      }
    })
    return defer.promise
  }

  listGenre(curUri) {
    var self = this
    var defer = libQ.defer()
    var splitted = curUri.split('/')
    var genreName = decodeURIComponent(splitted[2])
    var genreArtist = decodeURIComponent(splitted[3])
    var safeGenreName = genreName.replace(/"/g, '\\"')
    var safeGenreArtist = genreArtist.replace(/"/g, '\\"')
    var response = {
      navigation: {
        lists: [
          {
            title: genreName + ' ' + self.commandRouter.getI18nString('COMMON.ALBUMS'),
            icon: 'fa icon',
            availableListViews: ['list', 'grid'],
            items: [],
          },
          {
            title: genreName + ' ' + self.commandRouter.getI18nString('COMMON.ARTISTS'),
            icon: 'fa icon',
            availableListViews: ['list', 'grid'],
            items: [],
          },
        ],
        prev: {
          uri: 'genres://',
        },
      },
    }

    self.mpdReady.then(function () {
      let findString
      if (genreArtist != 'undefined') {
        if (artistsort) {
          findString = 'find genre "' + safeGenreName + '" albumartist "' + safeGenreArtist + '" '
        } else {
          findString = 'find genre "' + safeGenreName + '" artist "' + safeGenreArtist + '" '
        }
      } else {
        findString = 'find genre "' + safeGenreName + '"'
      }
      self.clientMpd.sendCommand(libMpd.cmd(findString, []), function (err, msg) {
        var albums = []
        var artists = []

        if (msg) {
          var lines = msg.split('\n')
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i]
            if (line.indexOf('file:') === 0) {
              const {path, albumartistOrArtist: artist, album} = parseMpdOutput(lines, i)
              var albumart = self.getAlbumArt(
                {artist: artist, album: album},
                self.getParentFolder(path),
                'dot-circle-o'
              )

              if (artistsort) {
                // for albumArtist
                if (albums.indexOf(album) === -1) {
                  albums.push(album)

                  if (album !== '') {
                    response.navigation.lists[0].items.push({
                      service: 'mpd',
                      type: 'folder',
                      title: album,
                      artist,
                      albumart,
                      uri:
                        'genres://' +
                        encodeURIComponent(genreName) +
                        '/' +
                        encodeURIComponent(artist) +
                        '/' +
                        encodeURIComponent(album),
                    })
                  }
                }

                if (artists.indexOf(artist) === -1) {
                  artists.push(artist)
                  if (artist !== '') {
                    response.navigation.lists[1].items.push({
                      service: 'mpd',
                      type: 'folder',
                      title: artist,
                      albumart: self.getAlbumArt({artist: artist}, undefined, 'users'),
                      uri: 'genres://' + encodeURIComponent(genreName) + '/' + encodeURIComponent(artist),
                    })
                  }
                }
              } else {
                // for artist
                if (albums.indexOf(album) === -1) {
                  albums.push(album)
                  if (album !== '') {
                    response.navigation.lists[0].items.push({
                      service: 'mpd',
                      type: 'folder',
                      title: album,
                      artist,
                      albumart,
                      uri:
                        'genres://' +
                        encodeURIComponent(genreName) +
                        '/' +
                        encodeURIComponent(artist) +
                        '/' +
                        encodeURIComponent(album),
                    })
                  }
                }

                if (artists.indexOf(artist) === -1) {
                  artists.push(artist)
                  if (artist !== '') {
                    response.navigation.lists[1].items.push({
                      service: 'mpd',
                      type: 'folder',
                      title: artist,
                      albumart: self.getAlbumArt({artist: artist}, undefined, 'users'),
                      uri: 'genres://' + encodeURIComponent(genreName) + '/' + encodeURIComponent(artist),
                    })
                  }
                }
              }
            }
          }

          defer.resolve(response)
        } else {
          self.logger.error('List Genre error: ' + err)
          defer.reject(new Error())
        }
      })
    })
    return defer.promise
  }

  getMixerControls() {
    this.commandRouter.executeOnPlugin('audio_interface', 'alsa_controller', 'getMixerControls', '1')
  }

  getParentFolder(file) {
    var index = file.lastIndexOf('/')

    if (index > -1) {
      return file.substring(0, index)
    } else return ''
  }

  getAlbumArtPathFromUri(uri) {
    var startIndex = 0
    var splitted = uri.split('/')
    while (splitted[startIndex] === '') {
      startIndex = startIndex + 1
    }

    if (splitted[startIndex] === 'mnt') {
      startIndex = startIndex + 1
    }

    var result = ''

    for (var i = startIndex; i < splitted.length - 1; i++) {
      result = result + '/' + splitted[i]
    }

    return result
  }

  prefetch(trackBlock) {
    var self = this
    this.logger.info('DOING PREFETCH IN MPD')
    var uri = this.sanitizeUri(trackBlock.uri)

    var urilow = trackBlock.uri.toLowerCase()
    if (urilow.endsWith('.dff') || urilow.endsWith('.dsd') || urilow.endsWith('.dxd') || urilow.endsWith('.dsf')) {
      setTimeout(function () {
        self.dsdVolume()
      }, 5000)
    }
    var safeUri = uri.replace(/"/g, '\\"')
    return this.sendMpdCommand('add "' + safeUri + '"', []).then(function () {
      return self.sendMpdCommand('consume 1', [])
    })
  }

  goto(data) {
    if (data.type === 'artist') {
      return this.listArtist(
        'artists://' + encodeURIComponent(data.value),
        2,
        '',
        'albums://' + encodeURIComponent(data.value) + '/'
      )
    } else if (data.type === 'album') {
      return this.listAlbumSongs(
        'albums://' + encodeURIComponent(data.artist) + '/' + encodeURIComponent(data.album),
        2,
        'albums://' + encodeURIComponent(data.artist) + '/'
      )
    }
  }

  ignoreUpdate(data) {
    ignoreupdate = data
  }

  ffwdRew(millisecs) {
    var self = this

    var defer = libQ.defer()

    var cmd = libMpd.cmd
    var delta = millisecs / 1000

    var param

    if (delta > 0) {
      param = '+' + delta
    } else {
      param = delta
    }

    self.clientMpd.sendCommand(cmd('seekcur', [param]), function (err) {
      if (err) {
        defer.reject(new Error('Cannot seek ' + millisecs))
      } else {
        defer.resolve()
      }
    })
    return defer.promise
  }

  loadLibrarySettings() {
    var tracknumbersConf = this.config.get('tracknumbers', false)
    var compilationConf = this.config.get('compilation', 'Various,various,Various Artists,various artists,VA,va')
    var artistsortConf = this.config.get('artistsort', true)
    var singleBrowseConf = this.config.get('singleBrowse', false)
    var stickingMusicLibraryConf = this.config.get('stickingMusicLibrary', false)

    tracknumbers = tracknumbersConf
    compilation = compilationConf.split(',')
    artistsort = artistsortConf
    singleBrowse = singleBrowseConf
    stickingMusicLibrary = stickingMusicLibraryConf
  }

  saveMusicLibraryOptions(data) {
    var self = this

    self.config.set('tracknumbers', data.tracknumbers)
    self.config.set('compilation', data.compilation)
    self.config.set('artistsort', data.artistsort.value)

    tracknumbers = data.tracknumbers
    compilation = data.compilation.split(',')
    artistsort = data.artistsort.value

    self.commandRouter.pushToastMessage(
      'success',
      self.commandRouter.getI18nString('APPEARANCE.MUSIC_LIBRARY_SETTINGS'),
      self.commandRouter.getI18nString('COMMON.CONFIGURATION_UPDATE')
    )

    var ffmpegenable = this.config.get('ffmpegenable', false)
    if (data.ffmpegenable && ffmpegenable !== data.ffmpegenable) {
      self.config.set('ffmpegenable', data.ffmpegenable)
      setTimeout(function () {
        self.createMPDFile(function (error) {
          if (error) {
            self.logger.error('Cannot create mpd file: ' + error)
          } else {
            self.restartMpd(function (error) {
              if (error) {
                self.logger.error('Cannot restart MPD: ' + error)
              } else {
                setTimeout(function () {
                  self.rescanDb()
                }, 3000)
              }
            })
          }
        })
      }, 500)
    }
  }

  dsdVolume() {
    var self = this

    if (dsd_autovolume) {
      self.logger.info('Setting Volume to 100 automatically for DSD')
      self.commandRouter.volumiosetvolume(100)
    }
  }

  rebuildAlbumCache() {
    var self = this

    self.logger.info('Rebuild Album cache')
    memoryCache.del('cacheAlbumList', function () {})
    self.listAlbums()
  }

  registerConfigCallback(callback) {
    var self = this
    self.logger.info('register callback: ' + JSON.stringify(callback, null, 4))
    self.registeredCallbacks.push(callback)
  }

  checkUSBDrives() {
    var self = this

    var usbList = self.lsInfo('music-library/USB')
    usbList
      .then((list) => {
        if (list.navigation.lists[0].items.length > 0) {
          var diskArray = list.navigation.lists[0].items
          for (var i in diskArray) {
            var disk = diskArray[i]
            if (disk.uri) {
              var path = disk.uri.replace('music-library', '/mnt')
              if (!fs.existsSync(path)) {
                return this.sendMpdCommand('update', ['USB'])
              }
            }
          }
        }
      })
      .fail((e) => {
        self.logger.error('Error in refreshing USB drives list' + e)
      })
  }

  deleteFolder(data) {
    var self = this
    var defer = libQ.defer()

    if (data && data.curUri && data.item && data.item.uri) {
      var folderToDelete = data.item.uri.replace('music-library', '/mnt')
      exec('/usr/bin/sudo /bin/rm -rf "' + folderToDelete + '"', {uid: 1000, gid: 1000}, function (error) {
        if (error) {
          self.logger.error('Cannot delete folder: ' + error)
          defer.reject('Cannot delete folder ' + data.curUri)
        } else {
          var list = self.lsInfo(data.curUri)
          list
            .then((list) => {
              var items = list.navigation.lists[0].items
              for (var i in items) {
                if (items[i].uri === data.item.uri) {
                  list.navigation.lists[0].items.splice(i, 1)
                }
              }
              defer.resolve(list)
            })
            .fail((e) => {
              self.logger.error('Error in refreshing USB drives list' + e)
              defer.reject(e)
            })
        }
      })
    }

    exec('/bin/sync', {uid: 1000, gid: 1000}, function (error) {
      if (error) {
        self.logger.error('Cannot execute sync')
      }
    })
    return defer.promise
  }

  getSpecialCardConfig() {
    var self = this

    try {
      var specialCardsConfig = libFsExtra.readJsonSync(__dirname + '/special_cards_config.json')
    } catch (e) {
      var specialCardsConfig = {}
    }
    var outdevName = self.getAdditionalConf('audio_interface', 'alsa_controller', 'outputdevicename')

    if (specialCardsConfig[outdevName] && specialCardsConfig[outdevName].length) {
      return specialCardsConfig[outdevName]
    } else {
      return null
    }
  }

  getPlaybackMode() {
    var self = this

    //values: continuous|single
    var playbackMode = self.config.get('playback_mode_list', 'unset')
    if (playbackMode === 'unset') {
      if (process.env.DEFAULT_PLAYBACK_MODE_CONTINUOUS === 'true') {
        playbackMode = 'continuous'
      } else {
        playbackMode = 'single'
      }
    }
    process.env.PLAYBACK_MODE = playbackMode

    return playbackMode
  }

  setPlaybackMode(mode) {
    var self = this

    //values: continuous|single
    self.config.set('playback_mode_list', mode)
    process.env.PLAYBACK_MODE = mode
  }

  checkIfSoxCanBeMultithread() {
    var self = this

    var deviceHw = self.getAdditionalConf('system_controller', 'system', 'device')
    if (deviceHw === 'Raspberry PI') {
      return false
    } else {
      var coresNumber = self.commandRouter.executeOnPlugin('system_controller', 'system', 'getCPUCoresNumber', '')
      if (coresNumber > 1) {
        return true
      } else {
        return false
      }
    }
  }
}

module.exports = ControllerMpd
