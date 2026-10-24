# Browser attachments

Browser pickers return `blob:` or `data:` URLs, not native filesystem paths.
`mediaUpload` reads these through the bounded `readWebAttachment` helper.
Private attachments use encrypted blob delivery on web, iOS and Android, with
an 8,000,000-byte plaintext limit. A local Helia CID is not proof that a recipient
can retrieve the bytes. Public IPFS requires an explicit `publicIpfs` option;
private sends never fall back to plaintext IPFS when the relay fails. Native
clients retain the filesystem path and bounded native reads.

Encrypted `nb:` attachments are decrypted in memory on web. Resolution preserves
relay-host allowlisting, ciphertext size limits and authenticated decryption.
The result is a data URL; no decrypted filesystem cache is created. Only raster
images, audio and video keep an inline MIME type. HTML, SVG and other document
formats receive `application/octet-stream` to avoid executing active content.

Relay responses are read with a streaming byte budget, including when
`Content-Length` is absent or incorrect. Downloads keep the ciphertext budget;
upload acknowledgment JSON is capped at 64 KiB. Both operations reject redirects
and omit cookies. Native requests use `expo/fetch` so redirect rejection is
enforced by the native transport. A missing streaming API fails closed.

The upload must retain ntfy's message metadata: setting `Cache: no` can make a
successful upload's returned file URL respond with 404. The random hosting topic
has no application subscribers and carries ciphertext only.

Successful upload is not proof of recipient rendering: browser acceptance must
also open the attachment at the receiving account. Large attachment limits and
relay availability still apply.

Web document actions download through a temporary object URL with an octet-stream
MIME type and a sanitized filename; they do not pass data URLs to native sharing.
The temporary URL is revoked after a delay so Safari can finish consuming it.
