# 🔴 Rubro

**Sua voz, no ponto.**

O painel do seu microfone, feito para quem não entende de áudio.
O visual segue o próprio microfone: corpo preto, detalhes em vermelho e uma grade que "acende" quando você fala.

**Autor:** Arthur Macaúbas
© 2026 Arthur Macaúbas. Todos os direitos reservados.

## O que ele faz

- Mostra se o microfone está conectado, com frases simples ("Estou te ouvindo bem! 👍").
- Medidor de voz desenhado como a grade do microfone.
- Botão de mudo gigante, com atalho `Ctrl + M`.
- "Ajustar sozinho": você fala por 5 segundos e ele acerta o volume da sua voz.
- Redutor de ruído em 3 níveis (Desligado, Leve, Forte), com leitura do barulho do ambiente.
- "Me ouvir no fone".
- Guia de primeiro uso em 3 passos e avisos com o passo a passo para cada problema.

## Como rodar

Precisa do [Node.js](https://nodejs.org) 20 ou mais novo.

```bash
npm install
npm run dev
```

O navegador abre sozinho. Use o Chrome ou o Edge e clique em "Permitir" quando ele pedir o microfone.
Se a porta 5173 estiver ocupada, o Vite usa a próxima livre e mostra o endereço no terminal.

## Estrutura

```
src/
  hooks/useMicrophone.js   toda a parte de áudio (Web Audio API)
  components/              tela: grade, botão de mudo, volume, ajustes, guia inicial
  styles/tokens.css        cores e fontes da marca
```

## Limitação atual

Na versão web, o volume e o redutor de ruído funcionam dentro do app (medidor e fone), não no microfone físico nem no som que outros programas recebem.
Controlar o hardware (ganho, LED e botão de mudo do aparelho) exige empacotar o app em Electron ou Tauri.
