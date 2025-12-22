#!/bin/bash
#
# Installs the infinization-nftables systemd service
# This service restores firewall rules on system boot
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_FILE="infinization-nftables.service"
SYSTEMD_DIR="/etc/systemd/system"
PERSISTENCE_DIR="/etc/infinization/nftables"

# Check for root
if [ "$EUID" -ne 0 ]; then
    echo "Error: This script must be run as root"
    exit 1
fi

echo "Installing infinization-nftables service..."

# Create persistence directory if it doesn't exist
if [ ! -d "$PERSISTENCE_DIR" ]; then
    echo "Creating persistence directory: $PERSISTENCE_DIR"
    mkdir -p "$PERSISTENCE_DIR"
    chmod 755 "$PERSISTENCE_DIR"
fi

# Copy service file
echo "Installing service file to $SYSTEMD_DIR"
cp "$SCRIPT_DIR/$SERVICE_FILE" "$SYSTEMD_DIR/$SERVICE_FILE"
chmod 644 "$SYSTEMD_DIR/$SERVICE_FILE"

# Reload systemd daemon
echo "Reloading systemd daemon..."
systemctl daemon-reload

# Enable service (but don't start - it will start on next boot)
echo "Enabling service..."
systemctl enable infinization-nftables.service

echo ""
echo "Installation complete!"
echo ""
echo "The service will automatically load firewall rules on system boot."
echo "Current status:"
systemctl status infinization-nftables.service --no-pager || true
echo ""
echo "Notes:"
echo "  - Firewall rules are stored in: $PERSISTENCE_DIR/infinization.nft"
echo "  - Rules are automatically exported by infinization after changes"
echo "  - To manually load rules: systemctl start infinization-nftables"
echo "  - To check status: systemctl status infinization-nftables"
