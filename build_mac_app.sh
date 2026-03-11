#!/bin/bash
# Builds a macOS .app bundle for NCTracks Eligibility Verifier
# Run once: bash build_mac_app.sh
# Then drag "NCTracks Verifier.app" to your Applications folder or Dock

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="NCTracks Verifier"
APP_DIR="$SCRIPT_DIR/$APP_NAME.app"

echo "Building $APP_NAME.app..."

# Create .app bundle structure
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

# Create Info.plist
cat > "$APP_DIR/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>NCTracks Verifier</string>
    <key>CFBundleDisplayName</key>
    <string>NCTracks Verifier</string>
    <key>CFBundleIdentifier</key>
    <string>com.nctracks.verifier</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleExecutable</key>
    <string>launch</string>
    <key>LSMinimumSystemVersion</key>
    <string>10.15</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>LSUIElement</key>
    <false/>
</dict>
</plist>
PLIST

# Create launcher script
# Uses pythonw if available (framework Python) — needed for Tkinter GUI in .app bundles
cat > "$APP_DIR/Contents/MacOS/launch" << LAUNCHER
#!/bin/bash
cd "$SCRIPT_DIR"

# Redirect output to a log file for debugging
exec > "\$HOME/Library/Logs/NCTracksVerifier.log" 2>&1

# Prefer pythonw (framework build, required for macOS GUI apps)
if command -v pythonw3 &>/dev/null; then
    exec pythonw3 main.py
elif command -v pythonw &>/dev/null; then
    exec pythonw main.py
else
    # Fall back to python3 with environment hint for Tk
    export OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES
    exec python3 main.py
fi
LAUNCHER
chmod +x "$APP_DIR/Contents/MacOS/launch"

echo ""
echo "Done! Created: $APP_DIR"
echo ""
echo "You can now:"
echo "  1. Double-click '$APP_NAME.app' to launch"
echo "  2. Drag it to your Applications folder"
echo "  3. Drag it to your Dock for quick access"
