# rok. — arkadaşlarla satranç

Tarayıcıda, kurulum ve sunucu gerektirmeden arkadaşlarınla satranç. Bir oda kur, beş harfli kodu gönder, yönetici olarak kimin kiminle hangi modda oynayacağını sen seç.

## Modlar

**Klasik** — Bildiğin satranç: şah mat, pat, rok, geçerken alma, terfi, üç tekrar, 50 hamle kuralı, yetersiz materyal. İstenirse süre kontrolü (3+2, 5, 10, 15+10).

**Unolu** — Her turdan önce desteden bir kart çekilir:

| Kart | Etkisi |
| --- | --- |
| **Sayı (1–3 / 1–5 / 1–9)** | Kaç gelirse o kadar hamle yaparsın (aynı taşla da olabilir). |
| **Yön değiştir** | Taraflar yer değiştirir: artık rakibinin taşlarıyla oynarsın. Sıradaki renk aynı kalır, yeni sahibi kart çeker. |
| **0 / Engel** | Tur boş geçer, sıra rakibe geçer. |
| **+2 / +4** | Yenen taşlarından 2 ya da 4 tanesini kendi yarında boş bir kareye geri koyarsın. |

Birden çok hamle yapıldığı için Unolu modda şah çekme kuralı yoktur: **şahı alınan kaybeder.**

## Oda sistemi

- Kullanıcı adıyla giriş yapılır, oda kuran kişi **yöneticidir**.
- Diğerleri kodla ya da `?oda=KOD` davet linkiyle katılır.
- Yönetici odadaki herkesi (kendisi dahil) istediği gibi eşleştirir, mod/süre/kart aralığını seçer. Aynı anda birden çok maç oynanabilir; boştakiler canlı maçları izleyebilir.
- Rövanş, beraberlik teklifi, terk etme, lobi sohbeti, oyuncu çıkarma.
- Sayfa yenilense de oyun kaldığı yerden devam eder; sekmesini kapatıp aynı kullanıcı adıyla geri gelen oyuncu eski yerine oturur.

## Nasıl çalışır?

Arka uç yoktur. Bağlantılar [PeerJS](https://peerjs.com) ile doğrudan tarayıcılar arasında (WebRTC) kurulur; oda yöneticisinin sekmesi oyunun tek doğruluk kaynağıdır (hamleleri doğrular, kartları karıştırır, saatleri tutar). Bu yüzden site GitHub Pages gibi statik bir barındırmada çalışır. Oda, yöneticinin sekmesi açık olduğu sürece yaşar.

```
js/chess.js   satranç motoru (hamle üretimi, SAN, perft ile doğrulandı)
js/game.js    maç kuralları: klasik + Unolu, saat, rövanş
js/room.js    oda sunucusu (yöneticinin sekmesinde çalışır)
js/net.js     PeerJS taşıma katmanı, yeniden bağlanma, kalp atışı
js/board.js   animasyonlu, sürükle-bırak tahta
js/app.js     arayüz
```

## Yerelde çalıştırma

Derleme adımı yok, herhangi bir statik sunucu yeter:

```bash
npx http-server -p 5173 -c-1
```

Sonra `http://localhost:5173` adresini iki farklı sekmede açıp deneyebilirsin.

## Lisans

Kod MIT lisanslıdır. Taş çizimleri Colin M.L. Burnett'e aittir ve [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) ile lisanslıdır.
