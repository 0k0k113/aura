"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTray = createTray;
const electron_1 = require("electron");
const path = __importStar(require("path"));
function createTray(window, rpc) {
    const iconPath = path.join(__dirname, '../assets/tray-icon.png');
    let icon;
    try {
        icon = electron_1.nativeImage.createFromPath(iconPath);
        if (icon.isEmpty()) {
            icon = electron_1.nativeImage.createEmpty();
        }
        else {
            icon = icon.resize({ width: 16, height: 16 });
        }
    }
    catch (error) {
        console.warn('[Tray] Failed to load icon, using empty image:', error);
        icon = electron_1.nativeImage.createEmpty();
    }
    const tray = new electron_1.Tray(icon);
    tray.setToolTip('Unreleasd Presence');
    const contextMenu = electron_1.Menu.buildFromTemplate([
        {
            label: 'Unreleasd Presence',
            enabled: false
        },
        { type: 'separator' },
        {
            label: 'Open unreleasd.world',
            click: () => {
                if (window) {
                    if (window.isMinimized())
                        window.restore();
                    window.show();
                    window.focus();
                }
            }
        },
        {
            label: 'Clear All Data',
            click: async () => {
                if (window && window.webContents) {
                    try {
                        await window.webContents.executeJavaScript(`
              localStorage.removeItem('rp_user');
              localStorage.removeItem('rp_sid');
            `, true);
                        const session = window.webContents.session;
                        await session.clearStorageData({
                            storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'cachestorage', 'serviceworkers', 'filesystem']
                        });
                        await session.clearCache();
                        await session.clearCodeCaches({});
                        await session.clearAuthCache();
                        await session.clearHostResolverCache();
                        window.webContents.clearHistory();
                        if (rpc) {
                            rpc.clearActivity();
                        }
                        window.reload();
                        new electron_1.Notification({
                            title: 'Unreleasd Presence',
                            body: 'All app data cleared'
                        }).show();
                    }
                    catch (error) {
                        console.error('[Tray] Failed to clear all data:', error);
                    }
                }
            }
        },
        { type: 'separator' },
        {
            label: 'Quit',
            role: 'quit'
        }
    ]);
    tray.setContextMenu(contextMenu);
    tray.on('click', () => {
        if (window) {
            if (window.isVisible()) {
                window.hide();
            }
            else {
                window.show();
                window.focus();
            }
        }
    });
    return tray;
}
//# sourceMappingURL=tray.js.map