![Logo](admin/selverf.png)
# ioBroker.selveRF

[![NPM version](https://img.shields.io/npm/v/iobroker.selverf.svg)](https://www.npmjs.com/package/iobroker.selverf)
[![Downloads](https://img.shields.io/npm/dm/iobroker.selverf.svg)](https://www.npmjs.com/package/iobroker.selverf)
![Number of Installations (latest)](https://iobroker.live/badges/selverf-installed.svg)
![Number of Installations (stable)](https://iobroker.live/badges/selverf-stable.svg)
[![Dependency Status](https://img.shields.io/david/Rintrium/iobroker.selverf.svg)](https://david-dm.org/Rintrium/iobroker.selverf)

[![NPM](https://nodei.co/npm/iobroker.selverf.png?downloads=true)](https://nodei.co/npm/iobroker.selverf/)

**Tests:** ![Test and Release](https://github.com/Rintrium/ioBroker.selverf/workflows/Test%20and%20Release/badge.svg)

## selveRF adapter for ioBroker

Connection with Selve actuators and sensors through USB-Gateway (right now only commeo actuators are supported)

## Changelog

### **WORK IN PROGRESS**
* Fix fatal crash when a timeout occurs

### 0.3.2 (2021-08-24)
* Added logo
* Changes for testing

### 0.3.1 (2021-08-10)
* Implemented retries for message sending and automatic adapter restarts

### 0.3.0 (2021-07-14)
* Implemented ability to receive multiple gateway messages from one message through the serialport
* Implemented handling of of command.result
* Implemented aggregation of commands to send
### 0.2.3 (2021-07-11)
* Implemented fault code handling from gateway
### 0.2.2 (2021-07-11)
* Improved logging
### 0.2.1 (2021-07-11)
* Serialport now properly closes, when the adapter is stopped
* small bugfixes
### 0.2.0 (2021-07-11)
* Refactored parts of the code and added more comments
* Implemented more states for commeo actuators
### 0.1.0 (2021-07-10)
* First implementation of commeo actuators
### 0.0.1 (2021-06-16)
* (Rintrium) initial release

## License
MIT License

Copyright (c) 2021 Rintrium <main@rintrium.de>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.