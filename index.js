const { platform, arch } = process

let nativeBinding = null
let loadError = null

switch (platform) {
  case 'win32':
    switch (arch) {
      case 'x64':
        try {
          nativeBinding = require('./index.win32-x64-msvc.node')
        } catch (e) {
          loadError = e
        }
        break
      case 'ia32':
        try {
          nativeBinding = require('./index.win32-ia32-msvc.node')
        } catch (e) {
          loadError = e
        }
        break
      case 'arm64':
        try {
          nativeBinding = require('./index.win32-arm64-msvc.node')
        } catch (e) {
          loadError = e
        }
        break
      default:
        loadError = new Error(`Unsupported architecture on Windows: ${arch}`)
    }
    break
  case 'darwin':
    switch (arch) {
      case 'x64':
        try {
          nativeBinding = require('./index.darwin-x64.node')
        } catch (e) {
          loadError = e
        }
        break
      case 'arm64':
        try {
          nativeBinding = require('./index.darwin-arm64.node')
        } catch (e) {
          loadError = e
        }
        break
      default:
        loadError = new Error(`Unsupported architecture on macOS: ${arch}`)
    }
    break
  case 'freebsd':
    if (arch !== 'x64') {
      loadError = new Error(`Unsupported architecture on FreeBSD: ${arch}`)
    } else {
      try {
        nativeBinding = require('./index.freebsd-x64.node')
      } catch (e) {
        loadError = e
      }
    }
    break
  case 'linux':
    switch (arch) {
      case 'x64':
        try {
          nativeBinding = require('./index.linux-x64-gnu.node')
        } catch (e) {
          loadError = e
          try {
            nativeBinding = require('./index.linux-x64-musl.node')
            loadError = null
          } catch (e) {
            loadError = e
          }
        }
        break
      case 'arm64':
        try {
          nativeBinding = require('./index.linux-arm64-gnu.node')
        } catch (e) {
          loadError = e
          try {
            nativeBinding = require('./index.linux-arm64-musl.node')
            loadError = null
          } catch (e) {
            loadError = e
          }
        }
        break
      case 'arm':
        try {
          nativeBinding = require('./index.linux-arm-gnueabihf.node')
        } catch (e) {
          loadError = e
        }
        break
      default:
        loadError = new Error(`Unsupported architecture on Linux: ${arch}`)
    }
    break
  default:
    loadError = new Error(`Unsupported OS: ${platform}, architecture: ${arch}`)
}

if (!nativeBinding) {
  if (loadError) {
    throw loadError
  }
  throw new Error(`Failed to load native binding`)
}

const { DatabaseCore } = nativeBinding

module.exports.DatabaseCore = DatabaseCore