class StopAfterCurrentService {
  constructor(pauseAction) {
    this.enabled = false
    this.trackId = null
    this.pauseAction = pauseAction
  }

  setEnabled(value, trackId = null) {
    this.enabled = value
    this.trackId = value ? trackId : null
  }

  isEnabled() {
    return this.enabled
  }

  toggle(trackId = null) {
    this.setEnabled(!this.enabled, trackId)
  }

  exec(trackId) {
    console.log('this.enabled', this.enabled)
    console.log('trackId', trackId)
    console.log('this.trackId', this.trackId)
    if (!this.enabled || !this.trackId) {
      return
    }
    if (trackId === this.trackId) {
      return
    }
    this.pauseAction()
  }
}

module.exports = {StopAfterCurrentService}
