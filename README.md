# 🎚️ DuoMix

**Dois microfones, uma mesa.**

Uma mesa de som simples para kits de dois microfones sem fio (dois transmissores e um receptor),
feita para quem não entende de áudio. O visual segue o próprio kit: corpo azul-ardósia, faces pretas,
botões amarelos, LEDs ciano e o friso creme do estojo.

**Autor:** Arthur Macaúbas
© 2026 Arthur Macaúbas. Todos os direitos reservados.

## O que ele faz

- **Um canal para cada microfone (TX1 e TX2)**, com nome editável, medidor de LEDs, fader, mudo e redutor de ruído próprios.
- **Master:** volume geral num botão giratório, medidor da mistura, mudo geral (`Ctrl + M`) e "Me ouvir no fone".
- **Ajustar tudo sozinho:** cada pessoa fala por 5 segundos e a mesa acerta o volume de cada microfone.
- **Redutor de ruído por canal** em 3 níveis (Off, Leve, Forte), com leitura do barulho do ambiente.
- Frases simples no lugar de números ("Ouvindo bem 👍", "Tá estourando!").
- Guia de primeiro uso em 3 passos e avisos com o passo a passo para cada problema.
- Atalhos: `Ctrl + M` mudo geral, `Alt + 1` / `Alt + 2` mudo de cada microfone.

## Como rodar

Precisa do [Node.js](https://nodejs.org) 20 ou mais novo.

```bash
npm install
npm run dev
```

O navegador abre sozinho. Use o Chrome ou o Edge e clique em "Permitir" quando ele pedir o microfone.

## Receptor em estéreo

Receptores duplos mandam o microfone 1 no canal esquerdo e o microfone 2 no direito **quando estão em modo estéreo**.
Em modo mono os dois chegam misturados: a mesa avisa e mostra tudo no canal 1.

## Estrutura

```
src/
  hooks/useMixer.js        toda a parte de áudio (Web Audio API): separa os canais, faders, portões, master
  components/              ChannelStrip, MasterStrip, Fader, Knob, SegmentMeter, ajustes, guia inicial
  styles/tokens.css        cores do kit e fontes
```

## Limitação atual

Na versão web, a mesa funciona dentro do app (medidores e fone), não no som que outros programas recebem.
Para mandar a mistura para o Discord, OBS ou Zoom, o app precisa virar programa de computador (Electron ou Tauri)
com um microfone virtual.
