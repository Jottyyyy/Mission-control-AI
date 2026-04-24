const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('missionControl', {
  platform: process.platform,
});
