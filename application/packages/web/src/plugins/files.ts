// Every file of Settings > Plugins on plugins.privacynotes.app, pinned by
// SHA-256. The app checks each file against this list before it keeps or
// loads it, and the upload job (.github/workflows/plugin-upload.yml, through
// tools/plugin-files/fetch.mjs) fails unless the bytes it would upload match
// it. So the host only ever holds the bytes the app expects.
//
// `path` is the file's key under the host root: `<folder>/<stem>-<sha12>.<ext>`,
// where sha12 is the start of `sha256`. A name is never reused. A `.zst` file
// is kept as downloaded; `rawBytes` and `rawSha256` describe it after unzstd.
// Translate: `directions` holds one list per direction (Firefox language
// codes), and a vocabulary that both directions share is in both lists.
//
// No imports, so Node can load this file with type stripping.
// Smart connections keeps its own list, MEANING_FILES in onDeviceAi.ts.
// Spec: docs/internal/specs/plugins-files.md (sections 1 and 3)
export const PLUGIN_FILES = {
  runtime: [
    { path: 'runtime/ort-wasm-simd-threaded-4b884c203b0f.wasm', bytes: 14_848_852, sha256: '4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d' },
  ],
  ocr: [
    { path: 'ocr/ppocrv6-small-det-d73e0058b7a8.onnx', bytes: 9_880_512, sha256: 'd73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e' },
    { path: 'ocr/ppocrv6-small-rec-5435fd747c9e.onnx', bytes: 21_159_378, sha256: '5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634' },
    { path: 'ocr/ppocrv6-small-rec-dict-b5f2bfe2bdd9.txt', bytes: 74_947, sha256: 'b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d' },
    { path: 'ocr/ppocrv5-eslav-rec-b3018ef2b09a.onnx', bytes: 7_887_627, sha256: 'b3018ef2b09a0250b6e0c8e871c927098363e5fd4df890cc68e8358eb0aaf1bd' },
    { path: 'ocr/ppocrv5-eslav-rec-dict-3e95f1581557.txt', bytes: 1_663, sha256: '3e95f1581557162870cacdba5af91a4c6be2890710d395b0c3c7578e7ee5e6eb' },
    { path: 'ocr/ppocrv5-arabic-rec-799113ebf267.onnx', bytes: 7_998_947, sha256: '799113ebf267fbe742deb99eb36e8d42c9ddc5291ceacf92add41b4d52a59110' },
    { path: 'ocr/ppocrv5-arabic-rec-dict-7f92f7dbb9b7.txt', bytes: 2_369, sha256: '7f92f7dbb9b75a4787a83bfb4f6d14a8ab515525130c9d40a9036f61cf6999e9' },
    { path: 'ocr/ppocrv5-th-rec-27618be66018.onnx', bytes: 7_891_015, sha256: '27618be66018f8598ac0a526a593f9f1cebf794e7eded93428e8fb016e537f5f' },
    { path: 'ocr/ppocrv5-th-rec-dict-57f5406f94bb.txt', bytes: 1_767, sha256: '57f5406f94bb6688fb7077f7be65f08bbd71cecf48c01ea26c522cb5c4836b7a' },
    { path: 'ocr/ppocrv5-korean-rec-92f0b7785e64.onnx', bytes: 13_418_787, sha256: '92f0b7785e64fc9090106a241cf4c1eb97472824558272751b88a2a4476d3a08' },
    { path: 'ocr/ppocrv5-korean-rec-dict-a88071c68c01.txt', bytes: 47_451, sha256: 'a88071c68c01707489baa79ebe0405b7beb5cca229f4fc94cc3ef992328802d7' },
  ],
  translate: {
    engine: [
      { path: 'translate/bergamot-engine-327fcfc7b7e9.wasm.zst', bytes: 1_211_955, sha256: '327fcfc7b7e9d95f6fa0844ebf899cfc05469872ef02d3aef5783182839a6255', rawBytes: 4_960_506, rawSha256: 'f38ef807636a7c994afedaab7ff8ffe0d590d21897f05139f747b80fd7bbe926' },
    ],
    directions: {
      'en-de': [
        { path: 'translate/model-en-de-db0fa25f3767.bin.zst', bytes: 22_461_496, sha256: 'db0fa25f3767efdf913ad7d213adf51702a87fb9b07f5e6c64fc4dc13c2eb2cf', rawBytes: 31_561_787, rawSha256: '8df29d9494d19f47fd5d97c6a73474c6f657e9f81c1a607c431d02befdf3810f' },
        { path: 'translate/lex-en-de-a483b34d541d.bin.zst', bytes: 1_696_246, sha256: 'a483b34d541dc8d4097cbfafbb188d68ee54d68368b96ed2e3d1e16bcfad40aa', rawBytes: 4_347_672, rawSha256: '7ed39f1cffbd68a27ddf05bbfe068de2060f1d7e69f1a20e27ae923551dd7393' },
        { path: 'translate/vocab-en-de-688bd61fce9f.spm.zst', bytes: 352_776, sha256: '688bd61fce9ff1a1f93b81f0f039f9a850a3f345b0a82e044a743ff48b71ffbc', rawBytes: 810_073, rawSha256: '69f730becafa48e3bb2c244eab66456877c08959a02f2bd5519b5a3088b62f9c' },
      ],
      'de-en': [
        { path: 'translate/model-de-en-1a1d3db174f2.bin.zst', bytes: 21_611_407, sha256: '1a1d3db174f2e555a2d5d11abc303cc839a84dace2de1dcc46d65e3a217d3a7c', rawBytes: 31_561_787, rawSha256: '3e6f7c2c2425d10824797270b382bee718ff34af2cab9308841c82ca46dc6f20' },
        { path: 'translate/lex-de-en-a308bd1cae2b.bin.zst', bytes: 1_953_706, sha256: 'a308bd1cae2bf372a352d2e37b9ba286616d2cf386d14bdf848b54f8eb1d7408', rawBytes: 4_945_796, rawSha256: '113b98460468360cca68c042e1cddf49c4e1931cbb975ed04349c9a3bd607010' },
        { path: 'translate/vocab-en-de-688bd61fce9f.spm.zst', bytes: 352_776, sha256: '688bd61fce9ff1a1f93b81f0f039f9a850a3f345b0a82e044a743ff48b71ffbc', rawBytes: 810_073, rawSha256: '69f730becafa48e3bb2c244eab66456877c08959a02f2bd5519b5a3088b62f9c' },
      ],
      'en-fr': [
        { path: 'translate/model-en-fr-98c229b4f356.bin.zst', bytes: 22_542_574, sha256: '98c229b4f356565fec4cd9ba9374b1fa0216965addeef7ca250d4a3ed4a396eb', rawBytes: 31_561_787, rawSha256: '6322e296d4fecfe395a8d5723da4ec37ecbe6d7613bb1dfcf4b28e2a47498b68' },
        { path: 'translate/lex-en-fr-371c84ca05d5.bin.zst', bytes: 1_703_263, sha256: '371c84ca05d528013638c4c19c24fb12a15cbe9208239e599498539467a0436e', rawBytes: 4_372_936, rawSha256: '2585ed98d3af0bc949865aedeb390493d591f56870814376e73e4144c41ed059' },
        { path: 'translate/vocab-en-fr-61c982758a3e.spm.zst', bytes: 348_946, sha256: '61c982758a3e7dc880a8dbc11aaf0fb04a1e4f5d2d7a36ee11bc419323f2ca80', rawBytes: 814_404, rawSha256: '783abf3abe075afdf8d85d233994bef2c3a064e935ab1bed946820aff6ac002a' },
      ],
      'fr-en': [
        { path: 'translate/model-fr-en-aba908645fa8.bin.zst', bytes: 22_712_124, sha256: 'aba908645fa802706cf9ab0bcbf95a6b1ff1281e65402c9225893c923bd73f9a', rawBytes: 31_561_787, rawSha256: '15f997bc0d13808b0b0fbd0786e684a3c8a52adcd8071844b76123fdacbf2b90' },
        { path: 'translate/lex-fr-en-97d54df5179b.bin.zst', bytes: 1_959_170, sha256: '97d54df5179b2c7909eb075367765829f6a17ac2304ba3dba28accff09fe26e2', rawBytes: 4_824_120, rawSha256: '87c6752ea908f5f0347c10ac0cf7d80d9c2f4f20c81c90168f3e8230b56d4440' },
        { path: 'translate/vocab-en-fr-61c982758a3e.spm.zst', bytes: 348_946, sha256: '61c982758a3e7dc880a8dbc11aaf0fb04a1e4f5d2d7a36ee11bc419323f2ca80', rawBytes: 814_404, rawSha256: '783abf3abe075afdf8d85d233994bef2c3a064e935ab1bed946820aff6ac002a' },
      ],
      'en-it': [
        { path: 'translate/model-en-it-ed0580da44b9.bin.zst', bytes: 23_600_729, sha256: 'ed0580da44b91afd665956959d893c02e16e27240542799a524a3041c523ca17', rawBytes: 31_561_787, rawSha256: '248f47568788ecc351da7e5e07064d4153b4f71e011364ae2c931ffeec4d1cc2' },
        { path: 'translate/lex-en-it-a97b81e39392.bin.zst', bytes: 1_646_871, sha256: 'a97b81e39392c07084f3e8340f119e31ae10529634dd0ad6bad1f945d94bb4c7', rawBytes: 4_133_192, rawSha256: '8b21914804625b2777dae7fdb636eb78f02a3eb8b7bceaa50f29ac740961da93' },
        { path: 'translate/vocab-en-it-ad75fd13305e.spm.zst', bytes: 346_942, sha256: 'ad75fd13305e6dc6ec6cc95e43fbb3cb2fe8b7ea60332f195785541325555db8', rawBytes: 812_724, rawSha256: '3ef0211d4ae6db21440892f180f2019fe2bfc110a330ffa9d2eca9665e4f2bc5' },
      ],
      'it-en': [
        { path: 'translate/model-it-en-5d3d5a8c463c.bin.zst', bytes: 22_858_815, sha256: '5d3d5a8c463cd9f3a35d99d72165281f66c4637d5297c15418fe1e7cda49856a', rawBytes: 31_561_787, rawSha256: '21b70978ce2f3b4da7a06b5de86a09abe3acd30b9eee1b2ebb3582b9bad790bf' },
        { path: 'translate/lex-it-en-b5855a724527.bin.zst', bytes: 1_878_098, sha256: 'b5855a724527cb0a41dbe0b83de9682a389dab2300904ab84c2a12f4e9056c2e', rawBytes: 4_713_616, rawSha256: '0700d6d70b30490e68ff9deca0b45b80310745b491855bde3a13e1692d0cbce1' },
        { path: 'translate/vocab-en-it-ad75fd13305e.spm.zst', bytes: 346_942, sha256: 'ad75fd13305e6dc6ec6cc95e43fbb3cb2fe8b7ea60332f195785541325555db8', rawBytes: 812_724, rawSha256: '3ef0211d4ae6db21440892f180f2019fe2bfc110a330ffa9d2eca9665e4f2bc5' },
      ],
      'en-es': [
        { path: 'translate/model-en-es-ce7ba731d335.bin.zst', bytes: 22_085_725, sha256: 'ce7ba731d3352d7e595d96ed4fac513744568eaf9a271daf90b5fa8fa33b195d', rawBytes: 31_561_787, rawSha256: '3b1c399511c01c84c36fae5c0524df44096288efdc8236e182b5c97d7ad2244c' },
        { path: 'translate/lex-en-es-0dd2945dc8a5.bin.zst', bytes: 1_687_731, sha256: '0dd2945dc8a5bbccad6fb1e1dfce137d363de839f4492cab717f60f1f38c09e6', rawBytes: 4_198_436, rawSha256: '7d51237c0a07027dcd61643cfbbb0f8c48597d19907ef53d2cae9d6bec2cf25c' },
        { path: 'translate/vocab-en-es-76b9ef220b22.spm.zst', bytes: 348_996, sha256: '76b9ef220b22cec379f097852ca6312cabf065d5ddfb05149d5af31aa050ec22', rawBytes: 816_054, rawSha256: '5ae254fa9b15aa182e70fd2a6186b1333c63a29a48043a9224c6aa4fcac058ad' },
      ],
      'es-en': [
        { path: 'translate/model-es-en-7d1a512f3d3c.bin.zst', bytes: 22_849_210, sha256: '7d1a512f3d3c420a0d87e52dccf6c83bf7eba7f4c54608824d3f86b757993a3e', rawBytes: 31_561_787, rawSha256: '4aed7734152ae0045d1a69ae49c86cfda18f53c61f90e95e1d1de1c7c7c3b033' },
        { path: 'translate/lex-es-en-5c3aae52d8fd.bin.zst', bytes: 1_880_457, sha256: '5c3aae52d8fddeb2e09098171cdecf059ea453474633edcebc77375b04cbcaee', rawBytes: 4_636_248, rawSha256: 'e2610211d3b9577d012638fe7e7e74ed7b4b708ce96b9e792e67c282a6492daa' },
        { path: 'translate/vocab-en-es-76b9ef220b22.spm.zst', bytes: 348_996, sha256: '76b9ef220b22cec379f097852ca6312cabf065d5ddfb05149d5af31aa050ec22', rawBytes: 816_054, rawSha256: '5ae254fa9b15aa182e70fd2a6186b1333c63a29a48043a9224c6aa4fcac058ad' },
      ],
      'en-nl': [
        { path: 'translate/model-en-nl-bccfa93a22ec.bin.zst', bytes: 22_991_428, sha256: 'bccfa93a22ec77e86dfa839dc49c1a11602b1918bb08dbdc8636b0fb8f5dcee1', rawBytes: 31_561_787, rawSha256: '7e8402da61972dc2fdcf7147c7f1e12f7916a6d9349514ee7a731288357575a9' },
        { path: 'translate/lex-en-nl-6ed3bcd2e369.bin.zst', bytes: 1_614_605, sha256: '6ed3bcd2e369a873452c0948597d5bc1c2e08878277635afab3385bb425798d2', rawBytes: 4_030_624, rawSha256: 'bb4922718f8ca6d746ad090c0a88110a664dc050ee3f311bce33698b4e1679e9' },
        { path: 'translate/vocab-en-nl-4e9d279e6813.spm.zst', bytes: 349_477, sha256: '4e9d279e681372a4dd9b81a737a5a06692d08ed1ecad3b58067e0576e838e5cc', rawBytes: 807_708, rawSha256: 'c09588ca5662b230ed65bd39a07f58d9f7dd21c3a19e4aeb1bff39bf3b297c56' },
      ],
      'nl-en': [
        { path: 'translate/model-nl-en-4337cb340c25.bin.zst', bytes: 22_001_741, sha256: '4337cb340c250f93360af3449e32cbfe059d9ba655ac1f2226d16180b93e8bac', rawBytes: 31_561_787, rawSha256: 'ff987741ff15a5d94fff16cbef28f2b0a85a6e9547d982fad60ac09d16d11270' },
        { path: 'translate/lex-nl-en-1d739818fbc6.bin.zst', bytes: 1_974_176, sha256: '1d739818fbc6bc2afeea12ecd382bfd22c5ec9847e26910080ef759ef5e047ce', rawBytes: 4_862_412, rawSha256: '811ac8f9dcbd12706e2d73a7057a7bbe6b9f0607d15170ffe9439977e8229b41' },
        { path: 'translate/vocab-en-nl-4e9d279e6813.spm.zst', bytes: 349_477, sha256: '4e9d279e681372a4dd9b81a737a5a06692d08ed1ecad3b58067e0576e838e5cc', rawBytes: 807_708, rawSha256: 'c09588ca5662b230ed65bd39a07f58d9f7dd21c3a19e4aeb1bff39bf3b297c56' },
      ],
      'en-pl': [
        { path: 'translate/model-en-pl-4c3e2a71b7f8.bin.zst', bytes: 21_869_196, sha256: '4c3e2a71b7f801eeb81394b3b4a66189b4ee850cf7202855157776c7fa55bf0b', rawBytes: 31_561_787, rawSha256: 'b0b59716bcc8f46b8dc6ab5c32a2732acaad42a5a6d9ae9b472526a1bb0d71d4' },
        { path: 'translate/lex-en-pl-9934637772a0.bin.zst', bytes: 1_379_394, sha256: '9934637772a0408e97b767b87580bd56678bbde6a1b9f73afd503aad174cba60', rawBytes: 3_540_052, rawSha256: 'd7d7b364673f633763c9f8f2e8ee9c7a184e92f4086e8b84abe870a2a8dbe5d5' },
        { path: 'translate/vocab-en-pl-7926a0be1849.spm.zst', bytes: 351_738, sha256: '7926a0be1849310fe58241d9b9539fe65f796dffcc7a8c52daa4a78234ebb2c0', rawBytes: 821_612, rawSha256: '2000f182efa8ce5f69bc3f9e574666b5bc2c0af684eedd32f69d15aa9021ea85' },
      ],
      'pl-en': [
        { path: 'translate/model-pl-en-bac2aaa11d0d.bin.zst', bytes: 21_997_629, sha256: 'bac2aaa11d0dd40aae999929702b3e97dd4c6e8780920a55edb58b40705593e5', rawBytes: 31_561_787, rawSha256: '06dbab3baa3bbceab746bc6a3bba807878f38536382c03acddf59d3edf3b5d94' },
        { path: 'translate/lex-pl-en-9ba237b16843.bin.zst', bytes: 1_809_189, sha256: '9ba237b1684337cd937e20205d2947fec2db65c08fa17b555e52236e87a41b09', rawBytes: 4_964_208, rawSha256: 'b295dfefa7022a62e105276e8c39fdfd67bffe588f4fd78583edd4e04ee0cb3b' },
        { path: 'translate/vocab-en-pl-7926a0be1849.spm.zst', bytes: 351_738, sha256: '7926a0be1849310fe58241d9b9539fe65f796dffcc7a8c52daa4a78234ebb2c0', rawBytes: 821_612, rawSha256: '2000f182efa8ce5f69bc3f9e574666b5bc2c0af684eedd32f69d15aa9021ea85' },
      ],
      'en-pt': [
        { path: 'translate/model-en-pt-b6ae4dfe27a5.bin.zst', bytes: 22_901_341, sha256: 'b6ae4dfe27a5fd5bfaaeb4d84c4297e69c83a329e7eb26ae6ceefafe5ab541c9', rawBytes: 31_561_787, rawSha256: '07892fd2544ee79dcb643615d8f2debb9793fae16842e87c328e27a3dd26a770' },
        { path: 'translate/lex-en-pt-c51d8fa1524a.bin.zst', bytes: 1_588_521, sha256: 'c51d8fa1524a4fd70ac32dc6ef8df2a7683ec8da1b7888ef0b82dc1fcbafd14b', rawBytes: 3_970_340, rawSha256: 'ccb4c31c9e1899d77a200e71a86958e6ef6c8649627d0bbf3f873b57d9f236bd' },
        { path: 'translate/vocab-en-pt-5b2ef32ade5c.spm.zst', bytes: 348_792, sha256: '5b2ef32ade5c06aa3503186dc8c73e0ff21374e097a071f04d73f8bb1ab0e052', rawBytes: 816_726, rawSha256: 'd9f46182823d5bbc84201252b2dfcac28f63e561f0ec827ed858f241864c9def' },
      ],
      'pt-en': [
        { path: 'translate/model-pt-en-f2543035eb4e.bin.zst', bytes: 22_030_075, sha256: 'f2543035eb4e0cf7814d373e7ae69a10d6b48bdcb47121b372ae7b796bbdf9e6', rawBytes: 31_561_787, rawSha256: '7b854f1ec5a485dd33efd7c1bc01dd7d5a57f566957c5e47722af333f0ce9157' },
        { path: 'translate/lex-pt-en-30d224e25a2e.bin.zst', bytes: 1_850_036, sha256: '30d224e25a2e1bdc3aa31af7398f4e317d96d71d463efe3284d4aef230f951c7', rawBytes: 4_634_492, rawSha256: '2685d8b6530be92a4db4cc61f15a097eb114552be15cb6c1699e9d2d99d24470' },
        { path: 'translate/vocab-en-pt-5b2ef32ade5c.spm.zst', bytes: 348_792, sha256: '5b2ef32ade5c06aa3503186dc8c73e0ff21374e097a071f04d73f8bb1ab0e052', rawBytes: 816_726, rawSha256: 'd9f46182823d5bbc84201252b2dfcac28f63e561f0ec827ed858f241864c9def' },
      ],
      'en-ja': [
        { path: 'translate/model-en-ja-f92259b99048.bin.zst', bytes: 32_431_590, sha256: 'f92259b9904812350b71f440c3328f3e2e856f31c1a3ab6002756380dd908e00', rawBytes: 43_849_787, rawSha256: '59ae659f9bb63e4f81f474fe3c03d3f4499434b5f9e779fab7c12a45f31fd562' },
        { path: 'translate/lex-en-ja-8954d5b63432.bin.zst', bytes: 1_751_977, sha256: '8954d5b63432366992b22ad2aaa11895e2643014835049fe677655540a705915', rawBytes: 4_128_360, rawSha256: 'edfb7eb47b98a2689b804ab3614c31b24f1257aa54b1154da3d85e1ae8152d9f' },
        { path: 'translate/srcvocab-en-ja-dd1e93d625d9.spm.zst', bytes: 345_747, sha256: 'dd1e93d625d9a8d8a42f75255343f302ea37527933eda1a490652b66a7408a64', rawBytes: 796_275, rawSha256: '970c98d174fc01e0339fbabbf45af36a4be3f26f819ec1a5ea1189f71e091889' },
        { path: 'translate/trgvocab-en-ja-5384abf34f0e.spm.zst', bytes: 361_180, sha256: '5384abf34f0e1298f795bd14909a577272059041e60f91a5eb10500e35d0ee98', rawBytes: 827_144, rawSha256: '3b3d9f8f3a034d98d0a476f1794fa79c01e4e98a967ceb6777a66ba2d03ec1e1' },
      ],
      'ja-en': [
        { path: 'translate/model-ja-en-dadb38563217.bin.zst', bytes: 31_973_916, sha256: 'dadb385632174c77ab57c130c9e3cab1cd1a6874fe85b799a8b0af439fe78c91', rawBytes: 43_977_787, rawSha256: '3a603e20bfe1be86071913f9e23ab5129075bc0a8490151020ac4821e4f17302' },
        { path: 'translate/lex-ja-en-571403c44adf.bin.zst', bytes: 3_359_102, sha256: '571403c44adfa4d545e9e4d537e0e7e56ab6bc3858669db7545c70b0bf39f31e', rawBytes: 9_348_172, rawSha256: '525f412f0d210536c2933c78ae395fa0bf2b5ee6cc5dda61ebc2e79410ebaee4' },
        { path: 'translate/vocab-ja-en-f41f32e36f87.spm.zst', bytes: 617_539, sha256: 'f41f32e36f879643a47fedbd0616fa12f416da62e23af8620ee4fc7705217acc', rawBytes: 1_443_222, rawSha256: '5cb217758bae05877bb3f0c2f612e4e7c1e4cb03c10db11f4a47098d7ae62919' },
      ],
      'en-ko': [
        { path: 'translate/model-en-ko-27a1ff5306d9.bin.zst', bytes: 33_362_245, sha256: '27a1ff5306d9325192e19bec69ad7ca870208937701602cdd259f49d53353fe6', rawBytes: 43_849_787, rawSha256: 'ffe5ef2ce3f2e944055e35310bab186f6a70d533a0ee4394adf716a0e383afbb' },
        { path: 'translate/lex-en-ko-d98258e56fd3.bin.zst', bytes: 2_451_078, sha256: 'd98258e56fd35c59555836286aeb4278df8275ee8b5eed314003d0895e93cc40', rawBytes: 6_449_612, rawSha256: '96efba97d4bb93ab362e5569bea0f115184d2f68d63b67305ee663c18e32fbeb' },
        { path: 'translate/srcvocab-en-ko-5d8d6196ece8.spm.zst', bytes: 345_003, sha256: '5d8d6196ece8c45747b78dfeea1364dc4097271ff04aea81364aa6133c080d50', rawBytes: 791_280, rawSha256: '8d4e3141868efd410eb86c2b60d41aa6bc6b46e4c4b2c0b85e3792493c69d802' },
        { path: 'translate/trgvocab-en-ko-0e9e37fe978a.spm.zst', bytes: 348_381, sha256: '0e9e37fe978a94ffa908180719517121d95b751012306976edf4e64f246ba78c', rawBytes: 815_353, rawSha256: '2ece21b28dd7022d36127d17423a74dabf544787dfc1cf614f7b565f93a4a1d3' },
      ],
      'ko-en': [
        { path: 'translate/model-ko-en-439031098a88.bin.zst', bytes: 31_458_175, sha256: '439031098a88a1975b0d3bfaccf99ea5a6c8448345a54e64ac9e1f032af07e7f', rawBytes: 43_977_787, rawSha256: '7cb30cbc0a86e242084756445268a2346136771c92b884d9b4ebb077f67d5507' },
        { path: 'translate/lex-ko-en-e09289af785e.bin.zst', bytes: 3_119_058, sha256: 'e09289af785ede03003a4ba0671095711211e203a0c10b966be0bb61d7c62010', rawBytes: 8_617_516, rawSha256: 'b26291f063ce216a74239275f0485534a38111203e59d42a2a56ba62d6eeb196' },
        { path: 'translate/vocab-ko-en-0ada2b1c9fde.spm.zst', bytes: 595_536, sha256: '0ada2b1c9fde85c727ee88d702d1444f9ae427fa85a5bc269035b936ba4a6673', rawBytes: 1_410_063, rawSha256: '1c72b740ab793cdc3a8f16913dd6b4e806c77421077dd2d85edeb7be38418598' },
      ],
      'en-zh-Hant': [
        { path: 'translate/model-en-zh-hant-8563ada56a7a.bin.zst', bytes: 32_758_465, sha256: '8563ada56a7a07323979057d9185e69eec530f70dbc06c1001089cb3f4c01c9f', rawBytes: 43_849_787, rawSha256: '559ab90d723a58c1f1e2ab7cc12137bc667af5ba3e325e3eb30b5cdc930db520' },
        { path: 'translate/lex-en-zh-hant-efbff0226db2.bin.zst', bytes: 1_726_096, sha256: 'efbff0226db207c2b698b711025e8a11c19ea66fc1cea816a6d182d2d3efff9d', rawBytes: 4_057_188, rawSha256: 'd891404d1436a7334df12539fe30a26f9e9f2b80bd42fdb8b5f8849e8a1e942b' },
        { path: 'translate/srcvocab-en-zh-hant-00736ec54a77.spm.zst', bytes: 346_110, sha256: '00736ec54a77532dd7c3f0c1473ed71503260465d67dc5c10d8096317ba932e4', rawBytes: 803_694, rawSha256: '2266df70492162a249ab1c0154f929bd6098b246544c666c1a0d5a24dde7d2ea' },
        { path: 'translate/trgvocab-en-zh-hant-41c1ce6c9e1f.spm.zst', bytes: 350_477, sha256: '41c1ce6c9e1fa4eb330dcef5abe718d2c32574d4c6a43dd37b2f22ad9907154b', rawBytes: 751_671, rawSha256: '22b91a4436d70b91ab8777c677252ab5fae2bc284d71f977df5206c110e3444c' },
      ],
      'zh-Hant-en': [
        { path: 'translate/model-zh-hant-en-5409128464ba.bin.zst', bytes: 33_343_885, sha256: '5409128464ba483dcc9b8a9994a232fbc3499be55c1bfc3dafc21e8219285a45', rawBytes: 43_849_787, rawSha256: '0aee91790894458f5d367551f6edcd4c9cb97852c34f221bcbf9f4701ebcf0cd' },
        { path: 'translate/lex-zh-hant-en-45332eaa996f.bin.zst', bytes: 2_360_209, sha256: '45332eaa996fe1b1c00c1a9fe084dfa513d84fc963c02fa84a0e9d247593685f', rawBytes: 6_385_944, rawSha256: 'aa7daf6cfc85c0cd2c10e2944d66f6da55497c9c6408789f3adfded4074c2fb1' },
        { path: 'translate/srcvocab-zh-hant-en-7f71a3343b2b.spm.zst', bytes: 354_022, sha256: '7f71a3343b2ba095545e64ad7799f5b1dae978ab5dbeea0702b6ec948654bde7', rawBytes: 769_669, rawSha256: '5cc6a76611dbf86219f109141533606b15ecb34eee83673bb86b2c16b14734db' },
        { path: 'translate/trgvocab-zh-hant-en-48763c078bb4.spm.zst', bytes: 347_743, sha256: '48763c078bb47d9be23559a1e50971545874382fc68a51faa7a39c2ff922768b', rawBytes: 812_572, rawSha256: '7bf002db37c10d3b114cc5588d7fdcb16c57d0fd1e2c34354c22cc9f0b6c3c29' },
      ],
      'en-ca': [
        { path: 'translate/model-en-ca-e226f70dc0f7.bin.zst', bytes: 22_714_103, sha256: 'e226f70dc0f72727d56107dc871ab0074f47eda1ba2c88fee013e60d2cf81f22', rawBytes: 31_561_787, rawSha256: '735881c99ff303e55eb2e92a3b86762523d5dd1a4797b2574b851062051426ee' },
        { path: 'translate/lex-en-ca-21af04d762eb.bin.zst', bytes: 1_538_773, sha256: '21af04d762eb5e1c0eef53953f95230974d068442178dbb4ca9eb8951f9e071e', rawBytes: 4_344_092, rawSha256: '8f2151a7fb75454f5167a8df8758ec02ab02c0302893851bad7caa6b729822fb' },
        { path: 'translate/vocab-en-ca-4d5e882e7278.spm.zst', bytes: 349_175, sha256: '4d5e882e7278133539e6b899e3c6a2d501ee09ac1af7f2c955e4855b74fb3132', rawBytes: 810_653, rawSha256: '64ebcb5f6cb5a954ced615e48a44a85e77a644e4910544014b299b8ee0fa1b1f' },
      ],
      'ca-en': [
        { path: 'translate/model-ca-en-c02a864c4cb7.bin.zst', bytes: 22_168_642, sha256: 'c02a864c4cb792b563a02067e6a2e6f220ac450ed3de60d849998df7007064e0', rawBytes: 31_561_787, rawSha256: 'b7f9c70823052f60c257eb1c4eff893abea3648aa9d1c23c8774e1e5ef061434' },
        { path: 'translate/lex-ca-en-470b9f9951a5.bin.zst', bytes: 1_667_664, sha256: '470b9f9951a51f1ab1e4267a9d41bcfc436ada9f10578a8a7a29f5f2bf84d10e', rawBytes: 4_359_552, rawSha256: '74880047539925630601d61aa6c29a0672046236ca6cf33eeaf6f6f6690e914e' },
        { path: 'translate/vocab-ca-en-e4b7830b44a4.spm.zst', bytes: 349_163, sha256: 'e4b7830b44a4188599d10a2726c309dc5ed4d5658e4fde5f672f47829bc64cba', rawBytes: 810_273, rawSha256: '6d22da90905873c2793d0805e34e5c27901b16e7e7a7a427696696f67dfe1f0e' },
      ],
      'en-cs': [
        { path: 'translate/model-en-cs-7a83ea3580b2.bin.zst', bytes: 22_714_358, sha256: '7a83ea3580b2d4f8fc490b38b74d7638e8eb488f2860f1ae66e0d5e7f75ba38d', rawBytes: 31_561_787, rawSha256: '1d7855f91c3e2b8ef79fbea62707d46ceb8a1ad01834ef6dd500f32a7006cc2c' },
        { path: 'translate/lex-en-cs-d08adc371880.bin.zst', bytes: 1_399_382, sha256: 'd08adc371880efb2685ba5f36d466027993b9788272ad8a37ccac63ee940ef54', rawBytes: 3_572_436, rawSha256: '699b9b59fe3acbcddf831380024b2e139f2cbe225dce96d59ade2b159318f58b' },
        { path: 'translate/vocab-en-cs-f9955569c41a.spm.zst', bytes: 350_374, sha256: 'f9955569c41ac41578c5f9923bb7d7dbe62ed343f6475cf31078608bd9f753d4', rawBytes: 815_154, rawSha256: 'ee4b8ce15c8e1237c5f7a2d04741341beb0a5d5c09820f7ec08f13ee2b212755' },
      ],
      'cs-en': [
        { path: 'translate/model-cs-en-68317506ddfb.bin.zst', bytes: 22_287_863, sha256: '68317506ddfb9c6b0ca38aaa47da82837a20764de83de54e9fe14f5a6c215f46', rawBytes: 31_561_787, rawSha256: 'c815273b31074492eaab0ccd78d33d7ac16f94088707ab2492abaedcb9ee0b75' },
        { path: 'translate/lex-cs-en-589ccd8040ee.bin.zst', bytes: 1_817_446, sha256: '589ccd8040ee6072e72d82f3ace02062491c26a61afd41ddd94089bc54fed3ce', rawBytes: 4_990_588, rawSha256: 'eba6bd9575251525f1941640ea0b6527a06e72a46421579eafea04d635ee20a8' },
        { path: 'translate/vocab-en-cs-f9955569c41a.spm.zst', bytes: 350_374, sha256: 'f9955569c41ac41578c5f9923bb7d7dbe62ed343f6475cf31078608bd9f753d4', rawBytes: 815_154, rawSha256: 'ee4b8ce15c8e1237c5f7a2d04741341beb0a5d5c09820f7ec08f13ee2b212755' },
      ],
      'en-sk': [
        { path: 'translate/model-en-sk-9765cf796937.bin.zst', bytes: 22_359_789, sha256: '9765cf79693796e6031f42892d50697898dd82044ff48f9a2319572597c3ffe9', rawBytes: 31_561_787, rawSha256: 'e33af359fd58c8958104b1b74b3ea302800ccba2f125c1629e09d7f9dd9a3804' },
        { path: 'translate/lex-en-sk-66dcee968a74.bin.zst', bytes: 1_247_884, sha256: '66dcee968a7466846e0e9924b9b9814e429ccd134177c4a4366055c4efd07c81', rawBytes: 3_356_348, rawSha256: 'f3d1aec4ee5246d6a6ee5dc7ed4c6b18f6071c7baca69bf1344aef675b95515d' },
        { path: 'translate/vocab-en-sk-49f63165c0c0.spm.zst', bytes: 341_557, sha256: '49f63165c0c04a461a83b148caa2364b47ca3aa513d1411be473b01b4d558319', rawBytes: 808_888, rawSha256: 'cfa6a9e601d74686b117f041eb1ad9de94c34219110b67367d570a9e27026a46' },
      ],
      'sk-en': [
        { path: 'translate/model-sk-en-3ff0a7572b1b.bin.zst', bytes: 12_641_384, sha256: '3ff0a7572b1b2c319b8de7825c263e502dbe9fadb44e5dc3d029774a1e20de72', rawBytes: 17_141_051, rawSha256: '1686f94838ace314719e945606a09a66dafd40847dd3fd352ad3f7a969aac62f' },
        { path: 'translate/lex-sk-en-235a55203e3a.bin.zst', bytes: 1_699_601, sha256: '235a55203e3a84e0f39a5b0e8606857f2944f8aff0ad20d41af46ce4b3b8e33b', rawBytes: 4_913_324, rawSha256: '18577a7ded6b9957c948f2a384683f7ce09def42336c8141eee7ba86b79e2c8e' },
        { path: 'translate/vocab-sk-en-73812cd813bd.spm.zst', bytes: 341_427, sha256: '73812cd813bd2e503a1cd5811c06e1f1f9284b873586ce2cf5ccc7f694340530', rawBytes: 808_082, rawSha256: '7d25655bd15f34d77db5d2cb96a51c7943c5528f37f83b677a09bb0ea4e4f59b' },
      ],
      'en-tr': [
        { path: 'translate/model-en-tr-c76db256457a.bin.zst', bytes: 13_065_518, sha256: 'c76db256457a62adfcc138e0e506901ad5e2c7000fd3c7e2cfa6a19f022eb1af', rawBytes: 17_141_051, rawSha256: 'ea3cd4ee09de190df265c78d84260e277a9a8a3ddff05eb55d72afe7fc0fdbf4' },
        { path: 'translate/lex-en-tr-788b3ef3a65f.bin.zst', bytes: 1_142_021, sha256: '788b3ef3a65fc604354942cccd9492ffb80472d0680bb9f2a47fd707a02e5801', rawBytes: 3_261_300, rawSha256: '3aba0be842bd4c192659c781e6fdce8eb9b2b1fff29a40d22f75da369d59f46f' },
        { path: 'translate/vocab-en-tr-263c27a85922.spm.zst', bytes: 335_980, sha256: '263c27a85922e52099a0c6e12ff3599d72ce870d2255b0af1a693a1213802497', rawBytes: 798_793, rawSha256: 'a220363d60391f7ce3df8ec9785424dbc00c24d5786d1a4308cf8ca3ed3385c2' },
      ],
      'tr-en': [
        { path: 'translate/model-tr-en-7797f95b4b44.bin.zst', bytes: 11_959_737, sha256: '7797f95b4b44a62de8ff4233530e7b752e62d90aa17622a63631e7e706891be1', rawBytes: 17_140_836, rawSha256: 'bd18594ac5a7f1d9997e7ea5bd80272082219cf8b1ce604766e4f207eb86abbf' },
        { path: 'translate/lex-tr-en-e86a893872b1.bin.zst', bytes: 1_817_316, sha256: 'e86a893872b19a02286b260b189c1c98c602b09eea2e05e8eb0af8d389bb7844', rawBytes: 4_662_492, rawSha256: 'd3374ab5267a73ee1aa1d926a298bd349426835f40856991ee959bc5cd4f9fce' },
        { path: 'translate/vocab-tr-en-e3b7133eb695.spm.zst', bytes: 349_554, sha256: 'e3b7133eb69572fc04634c0d0ec5926657fa5eb36d31d715781fe3413abed368', rawBytes: 811_353, rawSha256: 'ed328e589a3ccd70fd3ce7773fc3c01d8b7b18c687464cacf17fd40a8c0daadd' },
      ],
      'en-sv': [
        { path: 'translate/model-en-sv-423cd4672db9.bin.zst', bytes: 12_574_883, sha256: '423cd4672db902728c5c493db36397d1ae3d4a534998bc457ad31dcd63fe7e99', rawBytes: 17_141_051, rawSha256: '65ea0db8e658435846f297384face62dbf1804cfc92de8388b0e368e6ecc25a7' },
        { path: 'translate/lex-en-sv-afd09be8c4d3.bin.zst', bytes: 1_427_048, sha256: 'afd09be8c4d3ef162b45423f2608d23672a6bb55222b99f0f6ff14ec0ab37851', rawBytes: 3_948_180, rawSha256: '5761c39887a0e0cd3dd38d22cadc31cecd2a43b0514c4bba96b426736e7fd72d' },
        { path: 'translate/vocab-en-sv-bd66b6acac72.spm.zst', bytes: 337_453, sha256: 'bd66b6acac72ae771dd96445fc799f611880b1e695ea444da0535437710b8082', rawBytes: 793_868, rawSha256: 'ff7e366ff4228107e58d76ca348e7dea2eb325452363d68e0047e97fb483e40e' },
      ],
      'sv-en': [
        { path: 'translate/model-sv-en-729fe5d1804d.bin.zst', bytes: 12_667_710, sha256: '729fe5d1804d099655244ccb36c4c141f85ab5915bfc565f65ac9ba9cf577eb1', rawBytes: 17_141_051, rawSha256: '92d79e2725718b84aed486473bdfcbe6bba3e7094922d4bead8a121cfa346372' },
        { path: 'translate/lex-sv-en-1642fe7f66f4.bin.zst', bytes: 1_602_459, sha256: '1642fe7f66f47337ad7d9915022be622f761e73a1c4eadc55c1a2c8633ab99da', rawBytes: 4_645_680, rawSha256: '1c4640765e806d905cdc4f51158f6f869c78709b9e8a43070877965fa13c160e' },
        { path: 'translate/vocab-sv-en-1ba884da7973.spm.zst', bytes: 337_469, sha256: '1ba884da79738377c300bd84d7c7b06ce9c7ade7eb1447a4fb22f9e3b2fb8510', rawBytes: 793_049, rawSha256: '93427195fac4125722ed778707478ef78cb77b3fdf1ed5b93bee9fd36e30a8ec' },
      ],
      'en-ar': [
        { path: 'translate/model-en-ar-41dc919c1110.bin.zst', bytes: 22_272_394, sha256: '41dc919c1110508ad7f03ee53bbb28a54abd61d1b15bbc3fe51c5df5c9331016', rawBytes: 31_561_787, rawSha256: 'ae659d7045fc2e5d6ba50583586a5d94ee4358d92c019847e37b57a0e627faa8' },
        { path: 'translate/lex-en-ar-f5fe1d8d145e.bin.zst', bytes: 1_204_697, sha256: 'f5fe1d8d145e38b4c6fd9f7a35d0d5779388fa135743561e1d25e982d7191222', rawBytes: 3_139_692, rawSha256: '2b7194817c5dd9225ca90c0d908cc92e1d6d1f45625781a5feb037ac568d6a61' },
        { path: 'translate/vocab-en-ar-9f68a65a64d4.spm.zst', bytes: 351_089, sha256: '9f68a65a64d4c64ea41d94024160e1443ff51b6c7ba0a2f93e7702beaa0b1d25', rawBytes: 863_591, rawSha256: '8d93c54aa5e2044c416ec680b5ff9af0227bd698521666e8b1a1ea1b041fbae8' },
      ],
      'ar-en': [
        { path: 'translate/model-ar-en-beed6b0da737.bin.zst', bytes: 22_770_191, sha256: 'beed6b0da7378dfe256a9c0604a0d07dcb2b9ad4ce5295ac1ea6f1c5815eed65', rawBytes: 31_561_787, rawSha256: '7b7af0282dc5f4d8805b9a298c2fa828967e3f09ca10f1942ebeea0b2cfc12fa' },
        { path: 'translate/lex-ar-en-0dc3d51a8e41.bin.zst', bytes: 1_623_998, sha256: '0dc3d51a8e41da0ee6f53784e04b2cd044e20e15f15b09aa9c1d96047de803b4', rawBytes: 4_627_200, rawSha256: '4b45f14dbea40d368093a13563fc1ca48457ee70c1291c82b206f3baff210081' },
        { path: 'translate/vocab-ar-en-4e7256a9b84a.spm.zst', bytes: 349_058, sha256: '4e7256a9b84ae2773a5b32a234418d1c111a018b9e1bf2580ad83972d5166687', rawBytes: 860_035, rawSha256: '51b4ee3f828d10015464523d0b4f5a6c086b0b2a9bde716a581001cf6c260366' },
      ],
      'en-uk': [
        { path: 'translate/model-en-uk-ff694d02907b.bin.zst', bytes: 22_275_099, sha256: 'ff694d02907bdb7036b291d24e32600ee3c415aca70ffde5346bd6e130ba110b', rawBytes: 31_561_787, rawSha256: 'ed8bb4a811e1c45a259e91052080d25e5c8b4e2df0e59cb1521c04a57855ef97' },
        { path: 'translate/lex-en-uk-0996c9dab7ed.bin.zst', bytes: 1_140_141, sha256: '0996c9dab7edb0ea89acd854dcc5346647945a220436b454c5cd477068ae7048', rawBytes: 3_054_364, rawSha256: 'dbfd4f8dc95da9c575164f7fc95ef00a2fb5f7d9f51b656559f99eeebdb57c87' },
        { path: 'translate/vocab-en-uk-888881477ce9.spm.zst', bytes: 363_469, sha256: '888881477ce96954928a993c7df7d942a712b668a701dea01a0b5e76a46773f8', rawBytes: 922_077, rawSha256: '4dd6a91feff71e745395dcc0d52f885848ca0d843d5f70628ca51b3be1b70b45' },
      ],
      'uk-en': [
        { path: 'translate/model-uk-en-e396481ae9e0.bin.zst', bytes: 12_465_964, sha256: 'e396481ae9e04d359a46772ec222a164738dc2f5eac7cdb7df380940a2194df4', rawBytes: 17_141_051, rawSha256: '2e7b8bc9d2569d8b4ae244e964cdc343a0aa3735cc83ecb664be84a37cb45f48' },
        { path: 'translate/lex-uk-en-3e4c7f4c847a.bin.zst', bytes: 1_326_961, sha256: '3e4c7f4c847aba15f6bf190eea994a02faabef63ff5bc46a860045d6bfebaa30', rawBytes: 3_914_120, rawSha256: '32b5e0df493671a223cb5cb32430181cbb7fe6b5562c91dbc3d35410d37e5ff6' },
        { path: 'translate/vocab-uk-en-4e901bd72e6b.spm.zst', bytes: 344_405, sha256: '4e901bd72e6b8ea9cb4d772bf599bb961cbb950458bd8db915f9a367c58db85b', rawBytes: 886_410, rawSha256: '8b51480dfc4ca2d7a08d2bfdaa9e57353ca97e6cf3d5f9aba4c0179d3665bfc0' },
      ],
      'en-ru': [
        { path: 'translate/model-en-ru-a55b2af86653.bin.zst', bytes: 21_044_601, sha256: 'a55b2af86653d6e5f4501c674f3806535734f93540e83db19bffdafe456d0887', rawBytes: 31_561_787, rawSha256: '184cb5cda528eeefc0f75f5d0035d787b71d74af135e3c5608d01ae02ecfb920' },
        { path: 'translate/lex-en-ru-d7998ec23c85.bin.zst', bytes: 1_013_057, sha256: 'd7998ec23c850255c2436bab1a248944877f63bf1842e02f67e50807d172b1bf', rawBytes: 2_774_540, rawSha256: '4d91839726b960e70b6d05c53d0cffd16262832b1c0e1ea99d66f412dcc6a239' },
        { path: 'translate/vocab-en-ru-088a38d8b5fa.spm.zst', bytes: 345_737, sha256: '088a38d8b5faf6315b284e3088714f70a8c79438496b15826b6c62496503c447', rawBytes: 904_455, rawSha256: '56ee63e14e8cb926c394242adc3ed7cc602644c3d33058cff2ce2959d52a6258' },
      ],
      'ru-en': [
        { path: 'translate/model-ru-en-7ea801682242.bin.zst', bytes: 22_222_762, sha256: '7ea801682242498cb1ab3fcd7c17ed78d27849608cb9277781d27fe963b0c8bc', rawBytes: 31_561_787, rawSha256: 'aa0efa194b3dbd2da129ba0b8db8ef139126cb0914e57072f62061294746f1e2' },
        { path: 'translate/lex-ru-en-e22557093855.bin.zst', bytes: 1_553_356, sha256: 'e22557093855eb6e81170ffd91512fa49eac4bd17ffb1159eedc4339c6638aca', rawBytes: 4_397_908, rawSha256: 'c944e753f298bbdf6506388de7257fb48cbd12c83e2807e2c284fc323771895b' },
        { path: 'translate/vocab-ru-en-db7d5931908b.spm.zst', bytes: 366_313, sha256: 'db7d5931908ba7597ec12fcbab9109c5e254c582b1fe515e7d76ab2cd36388c6', rawBytes: 952_371, rawSha256: 'de8af5f87e231ee4016cec4bb482e6b584cb1ca34dcb624fc7b8398f25bb35df' },
      ],
      'en-th': [
        { path: 'translate/model-en-th-64245d72caec.bin.zst', bytes: 22_466_990, sha256: '64245d72caec9c3e05573ae7bf39f8eb1f07285214a4e6f88b27b78df05b7cb7', rawBytes: 31_561_787, rawSha256: '80e326097655fca75f841130da3338a849aa245374e1616448bcf37b9523a05a' },
        { path: 'translate/lex-en-th-6214e1e62f26.bin.zst', bytes: 1_202_033, sha256: '6214e1e62f26be63366c4f405cc9ca1c78f272e9005a5f8a650acb71ae16bf23', rawBytes: 3_016_612, rawSha256: '6961ce07f38e6c113a70855706aa7cad4cc828f986d1751c33f14699f885a2e8' },
        { path: 'translate/vocab-en-th-59a73a98188b.spm.zst', bytes: 372_200, sha256: '59a73a98188bbb03d8c9ab8bd02f72058c23d7671cc0c7980df79e4850718a53', rawBytes: 993_517, rawSha256: '5deff7093d558768f8c22406449202e27595f023cc383a2b66beed240ed46443' },
      ],
      'th-en': [
        { path: 'translate/model-th-en-27c4f9cc9d2a.bin.zst', bytes: 22_425_194, sha256: '27c4f9cc9d2ade0cfaaf3734c667342033a6687b7831051bd8eda48e3ba272c7', rawBytes: 31_561_787, rawSha256: 'f70a501324743668b031bee19cd001a66839e8e5dfc0b4a1c44d5ea99d4e8d66' },
        { path: 'translate/lex-th-en-5dd4e3082a66.bin.zst', bytes: 1_646_914, sha256: '5dd4e3082a661fe63f4f279f091be69a6ca21d5496849dbc9f270cab51dd14e4', rawBytes: 4_487_056, rawSha256: '3a7661a7f5c811c83f05f53008083b042fea0334fc6044ca1fda4982a8d48453' },
        { path: 'translate/vocab-th-en-d4ed7d2c170c.spm.zst', bytes: 372_594, sha256: 'd4ed7d2c170c75e9e08bc9e012b80d889018fb1d79f9945edb73907de58c5bc5', rawBytes: 995_429, rawSha256: 'b625d3dcdfa2b4bbec496c9a0a30d169c917464ac5ea75506c0699972fea95f0' },
      ],
    },
  },
  voice: [
    { path: 'voice/whisper-small-encoder-q8-969f5ac12974.onnx', bytes: 92_324_809, sha256: '969f5ac12974340386bf7a02ea6626003e5e2dee396ffc6ab0eec282bf55ba06' },
    { path: 'voice/whisper-small-decoder-q8-fcfc6100dc73.onnx', bytes: 156_780_950, sha256: 'fcfc6100dc7339e7507e10f8b274350be7c4f8d8b575f0293f94cc0e156d6d24' },
    { path: 'voice/whisper-small-vocab-50d6a919f0a0.json', bytes: 1_036_584, sha256: '50d6a919f0a0601d56a04eb583c780d18553aa388254ba3158eb6a00f13e2c1a' },
    { path: 'voice/whisper-small-generation-config-0b7407a4e53a.json', bytes: 3_837, sha256: '0b7407a4e53a677f826e03c75d409e6f830663932bf43dda3b08c5efa2223279' },
  ],
  // Spec: docs/internal/specs/plugins-speech-enhancement.md (section 10, step 12)
  cleanup: [
    { path: 'cleanup/dpdfnet2-48khz-hr-0b399f8a58dc.onnx', bytes: 10_596_848, sha256: '0b399f8a58dc4d70d8cd97541f5c39869406145193b957d00a03b66070944928' },
  ],
} as const;
