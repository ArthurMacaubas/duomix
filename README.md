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
- **Isolador de voz (IA) por canal:** uma rede neural (GTCRN, com RNNoise de reserva) deixa só a voz e tira o barulho até enquanto a pessoa fala. Roda no próprio navegador, sem mandar áudio para a internet, e só é baixada na primeira vez que alguém liga.
- **Redutor de ruído por canal** em 3 níveis (Off, Leve, Forte), com leitura do barulho do ambiente.
- **Nivelar voz por canal:** compressor que sobe quem fala baixo e segura quem grita. No master, um limitador impede a mistura de estourar.
- **Anti-vazamento:** quando uma pessoa fala, o microfone da outra abaixa 12 dB, para a voz não chegar duas vezes (com eco) pelos dois microfones.
- **Aviso "você está no mudo":** se alguém fala com o canal (ou o master) no mudo, aparece um aviso amarelo que liga o microfone com um toque. Ignora a voz vazada do outro microfone para não dar alarme falso.
- Frases simples no lugar de números ("Ouvindo bem 👍", "Tá estourando!").
- Guia de primeiro uso em 3 passos e avisos com o passo a passo para cada problema.
- Atalhos: `Ctrl + M` mudo geral, `Alt + 1` / `Alt + 2` mudo de cada microfone.

## Modo Auditório (PC → mesa de som)

Para usar os microfones num auditório: o receptor vai no PC, o DuoMix trata o som e a saída de fone do PC
vai por um cabo P2 até a mesa de som do auditório.

```
Lark M2 (TX1, TX2) → receptor USB-C → PC (DuoMix) → saída P2 → cabo P2 → mesa do auditório → caixas
```

Ligue o botão **Modo Auditório** no topo. Ele:

- manda a mistura para a saída do PC, subindo devagar (sem estalo nas caixas);
- deixa escolher **para onde vai o som** (fone/P2, HDMI...);
- tem um **tom de teste de 1 kHz** para o técnico acertar o volume na mesa (para sozinho em 1 minuto);
- mostra o **atraso estimado** dentro do PC (o "Isolar voz" acrescenta uns 16 ms);
- mantém a **tela sempre ligada** para o PC não dormir no meio do evento;
- traz um **checklist da ligação**.

Dicas: use uma entrada de **linha/AUX** da mesa (não a de microfone), com o **phantom power desligado**;
deixe o Windows em **Não incomodar** para notificações não saírem nas caixas; se aparecer zumbido com o
notebook na tomada, use um **isolador de ruído P2**.

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

Na versão web, a mesa sai pela placa de som do PC (fone, P2 ou Modo Auditório), mas não vira um microfone que outros programas (Discord, OBS, Zoom) possam escolher.
Para mandar a mistura para o Discord, OBS ou Zoom, o app precisa virar programa de computador (Electron ou Tauri)
com um microfone virtual.
