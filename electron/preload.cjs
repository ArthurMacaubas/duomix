/*
 * Ponte mínima entre o app de computador e a mesa (que é o mesmo código do site).
 * Só avisa a mesa de que ela está rodando como app: nenhum acesso ao sistema é exposto.
 */
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('duomix', Object.freeze({ desktop: true, platform: process.platform }));
