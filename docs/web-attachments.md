# Browser attachments

Browser pickers return `blob:` or `data:` URLs, not native filesystem paths.
`mediaUpload` reads these through the bounded `readWebAttachment` helper before
IPFS upload. The encrypted relay fallback uses the same reader; native clients
retain the filesystem path and bounded native reads.

Encrypted `nb:` attachments are decrypted in memory on web. Resolution preserves
relay-host allowlisting, ciphertext size limits and authenticated decryption.
The result is a data URL; no decrypted filesystem cache is created. Only raster
images, audio and video keep an inline MIME type. HTML, SVG and other document
formats receive `application/octet-stream` to avoid executing active content.

Successful upload is not proof of recipient rendering: browser acceptance must
also open the attachment at the receiving account. Large attachment limits and
relay availability still apply.
