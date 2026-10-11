# Phone, voice and files

Shipmate works as an everyday assistant on your phone: notifications when the crew needs you,
photos and documents in chat, and talking to the Captain out loud.

## Push notifications

Open **Settings → Notifications** on each phone or computer and press **Turn on for this
device**. Pick what that device gets:

- **Approval requests**: a crew member waits for your OK. The notification has **Approve** and
  **Deny** buttons that answer straight away, without opening the app.
- **Watch results**: one of your watches finished or failed.
- **Crew replies**: a reply on the Bridge while you have no Shipmate tab open.

**Send a test** checks every device at once. Devices that stop accepting notifications (the
app was uninstalled, or permission withdrawn) are removed automatically.

Requirements:

- Shipmate must be served over **HTTPS** (or opened on `localhost`), with `SHIPMATE_URL` set to
  that address. Browsers only allow service workers and push on secure origins.
- **iPhone and iPad** (iOS 16.4 or later): notifications only work in the installed app. In
  Safari tap Share → **Add to Home Screen**, open Shipmate from the Home Screen, then turn
  notifications on. iOS does not show Approve and Deny buttons; tapping the notification opens
  the request instead.
- The server sends notifications through the browser makers' push services (Google, Mozilla,
  Apple, Microsoft), so it needs outbound HTTPS to them. Messages are end-to-end encrypted
  (RFC 8291); the push service only sees an opaque blob. The signing key (VAPID) is generated on
  first use and kept encrypted with your other secrets, so it survives restarts and restores.
- Other push services (for example a self-hosted one) can be allowed with
  `SHIPMATE_PUSH_HOSTS=push.example.org,other.example.net`.

How the buttons stay safe: each approval notification carries a token that works for that one
request, for the person who was asked, once, for 30 minutes. The service worker sends it without
cookies, so a notification can never act as anyone, or on anything, else.

## Approvals from Discord, Telegram and Slack

When a crew member pauses for your OK in a conversation that lives in Discord, Telegram or
Slack, the card there has **Allow once**, **Always allow** and **Deny** buttons. You can also
just type the answer in that chat: `approve` (or `yes`, `ok`, 👍), `deny` (or `no`, 👎), or
`always`. A typed answer goes to your newest waiting card in that chat. Only the person who
was asked can answer; anyone else gets "Only <name> can answer this." When nothing is waiting,
those words go to the crew like any other message.

## Photos and files in chat

Use the paperclip next to the message box to attach photos (JPEG, PNG, WebP, GIF, up to 10 MB),
PDFs (up to 20 MB) and text files such as notes, CSV or JSON (up to 1 MB), up to eight per
message. On a phone there is also a camera button that opens the camera directly. You can paste
or drag files into the composer too. Sent photos show as thumbnails and files as chips in the
conversation.

- **Photos** go to the crew member's model as images. If that model cannot see images, Shipmate
  hands that one message to a model that can and says so in the chat. Pick which one under
  **Settings → Photos** (owner); **Automatic** prefers a model from the same provider, then the
  default model. Without any vision-capable model the crew member only hears the file names.
- **PDFs** are read on the server and their text is passed along (a scanned PDF without a text
  layer has no text; send photos of the pages instead). **Text files** are passed as text.
- When the Captain hands a task to a crew member, the photos stay with the Captain, who passes
  on what matters. Write to a crew member directly to show them a photo.
- Files are stored under `<data>/files/` (included in backups) and only the person who uploaded
  a file can open it. Deleting a conversation deletes its files. Uploads that are never sent are
  removed after a day.
- iPhones may save photos as HEIC, which models do not accept. The camera button and most
  share sheets hand over JPEG; otherwise set Settings → Camera → Formats → Most Compatible.
- Discord, Telegram and Slack bridges take text only for now; send photos and files in the web
  app.
