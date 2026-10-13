# Google Workspace (Gmail, Calendar, Drive)

The Google Workspace MCP server signs in with your own Google Cloud OAuth client. Shipmate runs
the sign-in and keeps the token; nothing else is needed on the server.

1. Open [Google Cloud console](https://console.cloud.google.com/) and create a project (or pick one).
2. **APIs & Services → Library**: enable the Gmail, Google Calendar, Google Drive, Google Docs,
   Google Sheets and Google Tasks APIs.
3. **Google Auth Platform → Branding / Audience**: set up the consent screen as **External** and
   add your Google account as a test user. Then press **Publish app** so it is "In production".
   While an app is in "Testing", Google expires its sign-ins after 7 days. An unverified app is
   fine for your own use; Google shows a warning screen you can click through.
4. **Clients → Create client**, type **Web application**.
5. In Shipmate, open **MCP servers**, install **Google Workspace**, and copy the **Redirect URI**.
   Paste it under **Authorized redirect URIs** in the Google client and save.
6. Copy the client ID and secret into Shipmate, press **Save**, then **Sign in with Google**.
7. Use **Assign to crew** to choose who gets Gmail, Calendar and Drive.

## The redirect URI

It is built from `SHIPMATE_URL`. Google only accepts https addresses with a real domain name, or
`http://localhost`. If `SHIPMATE_URL` is a LAN address like `http://192.168.1.20:3000`, Shipmate
uses `http://localhost:<port>/api/mcp/google/callback` instead: after you allow access, Google
opens a page that won't load, and you paste that page's address back into Shipmate. Behind a
reverse proxy with https (see [reverse-proxy.md](reverse-proxy.md)), set `SHIPMATE_URL` to the
https address and the paste step goes away.

If you change `SHIPMATE_URL` later, add the new redirect URI in Google Cloud too.
