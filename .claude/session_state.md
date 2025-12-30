# Session State - iPhone Bridge / ABCL

## Current Configuration

- **Port**: 3001 (IMPORTANT: Port 3000 is reserved for Zarchon in WalterfamWebsite)
- **URL**: `https://192.168.1.204:3001/?token=change-this-secret-token`
- **Firewall Rule**: "ABCL Relay Server" on port 3001, all profiles

## Port Assignment Notes

| Port | Service | Notes |
|------|---------|-------|
| 3000 | Zarchon | Reserved - WalterfamWebsite |
| 3001 | ABCL (Claude Relay) | Current |
| 8080 | MealPlanner | WalterfamWebsite |
| 27017 | MongoDB | WalterfamWebsite internal |

## Integration Status

- [ ] iPhone connectivity verified on port 3001
- [x] Firewall rule added for port 3001
- [x] Server running and responding locally
- [x] WALTERFAM-INTEGRATION.md updated to use port 3001
- [x] GBOperatorHelper CLAUDE.md updated with relay instructions

## Files Modified This Session

- `server/config.js` - Port set to 3001
- `start-server.bat` - Updated port references
- `WALTERFAM-INTEGRATION.md` - All port references updated to 3001
- `../GBOperatorHelper/CLAUDE.md` - Relay instructions and port updated

## Next Steps

1. Verify iPhone can connect to https://192.168.1.204:3001/?token=change-this-secret-token
2. If connection fails, investigate network/firewall further
3. Test session attachment and terminal input functionality
