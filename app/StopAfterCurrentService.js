class StopAfterCurrentService {
  constructor(pauseAction) {
    this.enabled = false
    this.trackId = null
    this.pauseAction = pauseAction
  }

  isOn() {
    return this.enabled
  }

  off() {
    this.setEnabled(false)
  }

  setEnabled(value, trackId = null) {
    this.enabled = value
    this.trackId = value ? trackId : null
  }

  toggle(trackId = null) {
    this.setEnabled(!this.enabled, trackId)
  }

  exec(trackId) {
    if (!this.enabled || !this.trackId || trackId === this.trackId) {
      return
    }
    this.pauseAction()
  }
}

module.exports = {StopAfterCurrentService}
