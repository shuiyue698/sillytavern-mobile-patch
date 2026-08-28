SillyTavern mobile GPT image patch

Install:
1. Close SillyTavern/Luker.
2. Copy the contents of this package into the SillyTavern server root.
3. Allow overwrite of matching files.
4. Start the server again and refresh the phone browser/app page.

This is a server-side patch for standard SillyTavern-compatible mobile
installations. It keeps API keys on the server request path and avoids mobile
WebView CORS failures. The image panel supports custom image URL/key, image
model and resolution selection, reference-image analysis, and per-message
generation controls.

If Luker is a sealed Android APK and does not expose its SillyTavern server
directory, this package cannot be installed into the APK itself.
