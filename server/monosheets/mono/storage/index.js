import { LocalStore } from './localStore.js';
import { ServerStore } from './serverStore.js';
import { loadSettings, saveSettings } from './settings.js';
export { loadSettings, saveSettings, LocalStore, ServerStore };
export function getStore(settings) { const s = settings || loadSettings(); return s.dataHome === 'server' ? new ServerStore(s.serverUrl || '') : new LocalStore(); }
