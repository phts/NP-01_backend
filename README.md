# PHTS NP-01: Volumio 3 backend

This is a modification of original [volumio3-backend] which is used by [PHTS NP-01].

Noticeable changes:

- "Play next" command [[9120a3a](https://github.com/volumio/volumio3-backend/commit/9120a3a7f980bfc346914507c0aebeecea6981a2)]
- Add year, track number into player state
- New CLI and websocket commands
- Reset volume, repeat and random state on queue clear (playing other album)
- Improve stability, performance and fixed bugs
- [...and more][commits]

[volumio3-backend]: https://github.com/volumio/volumio3-backend
[PHTS NP-01]: https://tsaryk.com/NP-01
[commits]: https://github.com/volumio/volumio3-backend/compare/master...phts:NP-01_volumio3-backend:master

<details>
<summary>README from original repo</summary>

[![Open Source Love](https://badges.frapsoft.com/os/v2/open-source.png?v=103)](https://github.com/ellerbrock/open-source-badges/)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Awesome](https://awesome.re/badge.svg)](https://github.com/thibmaek/awesome-raspberry-pi)
[![js-semistandard-style](https://img.shields.io/badge/code%20style-semistandard-brightgreen.svg?style=flat-square)](https://github.com/standard/semistandard)
[![Volumio](https://volumio.org/wp-content/uploads/2016/02/Volumio_logo_HD2000.jpg)](https://volumio.org)

## What is Volumio

Volumio is a Free and Open Source Linux Distribution, designed and fine-tuned exclusively for music playback. It runs on a variety of devices, typically small and cheap computers like the Raspberry PI, but also on low power PCs, notebooks or thin clients.

By flashing (installing) Volumio on any of this platforms, it will then become an headless Audiophile Music Player. Headless means that the only way to control it will be with another Mobile phone, computer or tablet.

This is made possible by Volumio’s UI: a web applications that runs on any device with a browser, and that allows an easy and intuitive control of your playback sessions. All communications between the webapp and Volumio will happen trough your home network.

## What's in this repo

This repository contains the source code of Volumio's Backend, which is a Node.Js application which:

- Manages running processes and daemons for audio playback
- Manages the system's vitals and configurations such as network, settings, lifecycle

## Other parts of Volumio

Volumio is made with several components, some of which are open-source. They are:

- [Volumio OS Build System ](https://github.com/volumio/volumio3-os)
- [Volumio Backend](https://github.com/volumio/volumio3-backend)
- [Volumio User interface](https://github.com/volumio/Volumio2-UI)

## Resources

Developers are welcome! Check out the resources:

- [Main documentation](https://developers.volumio.com)

</details>
