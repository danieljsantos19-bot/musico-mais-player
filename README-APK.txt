MÚSICO+ PLAYER — CAMINHO PARA APK

Este pacote pega o player web/PWA V38 e o coloca dentro de um aplicativo Android nativo.
O player continua usando IndexedDB e os arquivos ficam no aparelho para uso offline.

COMO GERAR O APK SEM ANDROID STUDIO

1. Crie um repositório no GitHub.
2. Envie TODOS os arquivos desta pasta para o repositório, mantendo as pastas.
3. No GitHub, abra a aba "Actions".
4. Selecione "Build Músico+ Player APK".
5. Clique em "Run workflow".
6. Quando terminar, abra a execução concluída e baixe o artefato "Musico-Mais-Player-APK".
7. Dentro dele estará o arquivo app-debug.apk.
8. Envie o APK para o celular e instale.

IMPORTANTE
- Isso não usa Android Studio.
- O build é feito pelo GitHub Actions usando Gradle + Android SDK.
- É um build de teste (debug), suficiente para instalar no celular.
- O projeto usa o player V38 original como conteúdo.
- A tela fica ligada enquanto o aplicativo está aberto.
- O armazenamento das músicas continua local no aparelho.

OBSERVAÇÃO SOBRE IMPORTAÇÃO
A versão web usa seleção de pasta (webkitdirectory). O empacotamento Android fornece um seletor de arquivos múltiplos. Portanto, no primeiro teste, selecione os MP3/LRC pelo seletor. Se o teste funcionar, podemos adaptar a seleção de pasta depois.
