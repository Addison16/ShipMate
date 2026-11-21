# Other apps: message an agent with a key

A personal key lets another app send a message to one of your agents and read the reply.
Use it from Siri Shortcuts, Home Assistant, a script, or anything that can make a web request.

## Make a key

Settings → Other apps → type what the key is for → **Make a key**. Copy it right away: it is
shown once, and Shipmate keeps only a fingerprint of it. Make one key per app, so you can remove
one without breaking the rest.

A key can:

- send a message to any agent you can use, and get the reply;
- read the latest reply of a chat it started;
- list your agents.

A key cannot open your other chats, files, lists or settings, and cannot make more keys. What
its chats cost counts as your usage, and your spending cap applies. Chats a key starts show in
your chat list marked "Other app". If an agent needs your approval for something, it asks in the
app as usual and the other app waits.

## The three addresses

Send the key with every request as `Authorization: Bearer <key>`.

| Request | What it does |
| --- | --- |
| `POST /api/v1/ask` | Send a message and wait for the reply |
| `GET /api/v1/chats/<chatId>` | The latest reply of a chat this key started |
| `GET /api/v1/agents` | Your agents: `{ "agents": [{ "id": "captain", "name": "Captain" }] }` |

`POST /api/v1/ask` takes JSON:

| Field | Meaning |
| --- | --- |
| `message` | What to say. Required. |
| `agent` | The agent's `id` from `/api/v1/agents`. Left out: your main assistant. |
| `newChat` | `true` starts a fresh chat. Left out: each key keeps one running chat per agent, so a follow-up remembers what came before. |
| `waitSeconds` | How long to wait for the reply, 1 to 600. Left out: 120. |

It answers:

```json
{ "status": "done", "chatId": "…", "reply": "Milk, eggs and coffee." }
```

When the agent needs longer than the wait, `status` is `"working"` and `reply` is `null`. The
agent keeps going; ask `GET /api/v1/chats/<chatId>` for the reply later. A second message to a
chat that is still answering gets a 409.

```sh
curl https://shipmate.example.com/api/v1/ask \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message": "What is on the grocery list?"}'
```

## Siri Shortcuts

1. In the Shortcuts app, make a new shortcut and add **Ask for Input** (or **Dictate Text**).
2. Add **Get Contents of URL**. Set the URL to `https://your-shipmate/api/v1/ask`, Method to
   **POST**, add a header `Authorization` with the value `Bearer YOUR_KEY`, and set Request Body
   to **JSON** with one text field, `message`, set to the input from step 1.
3. Add **Get Dictionary Value** for the key `reply`.
4. Add **Speak Text** (or **Show Result**) with that value.

Name the shortcut something like "Ask Shipmate" and say that name to Siri. Apple's own guide to
the web request action:
[Request your first API in Shortcuts](https://support.apple.com/guide/shortcuts/request-your-first-api-apd58d46713f/ios).

Your phone has to be able to reach Shipmate: on your home network, or through your reverse proxy
or VPN when you are away.

## Home Assistant

Add a [RESTful Command](https://www.home-assistant.io/integrations/rest_command/) to
`configuration.yaml`. Home Assistant gives up on a request after 10 seconds unless you set
`timeout`, and agents often take longer, so set it.

```yaml
rest_command:
  ask_shipmate:
    url: "https://your-shipmate/api/v1/ask"
    method: post
    timeout: 120
    content_type: "application/json"
    headers:
      authorization: !secret shipmate_key   # in secrets.yaml:  shipmate_key: "Bearer YOUR_KEY"
    payload: '{"message": {{ message | tojson }}, "waitSeconds": 110}'
```

Use it in an automation and read the reply with `response_variable`:

```yaml
actions:
  - action: rest_command.ask_shipmate
    data:
      message: "The washer just finished. Remind whoever is home."
    response_variable: answer
  - action: notify.notify
    data:
      message: "{{ answer['content']['reply'] }}"
```

## Remove a key

Settings → Other apps → **Remove**. The key stops working at once. The chats it started stay in
your list.
