# ABSO Integration: CNM (Celio's Network Machine) Handler

This document provides instructions for a CLI agent to add CNM stopping/starting functionality to the **A.B.S.O. (Adaptive Battle Station Optimizer)** codebase.

## Overview

**CNM (Celio's Network Machine)** is a WebSocket-based terminal relay system that:
- Runs a Node.js server on port 3001
- Has a system tray application (PowerShell)
- Has a Windows scheduled task for auto-start
- Uses `SetThreadExecutionState` to keep the system awake

When gaming optimizations are applied, CNM should be **stopped** to:
- Free port 3001
- Stop background Node.js process
- Stop the keep-awake functionality (allows power optimizations to work)
- Reduce background CPU/memory usage

## Integration Requirements

### 1. Create the CNM Settings Handler

Create file: `abso/settings/cnm.py`

```python
"""CNM (Celio's Network Machine) settings handler.

Manages the CNM relay server and tray application for gaming optimization.
When gaming, CNM should be stopped to:
- Free resources (Node.js process, port 3001)
- Allow power optimizations (CNM keeps system awake)
- Reduce background processes
"""

from __future__ import annotations

import logging
import subprocess
from pathlib import Path
from typing import Any, Literal, cast

from abso.core.models import Issue
from abso.settings.base import SettingsHandler

SeverityType = Literal["critical", "warning", "info"]

logger = logging.getLogger(__name__)


class CNMSettingsHandler(SettingsHandler):
    """Handles CNM (Celio's Network Machine) optimization settings.

    CNM is a WebSocket relay server for remote terminal access.
    For gaming, it should be stopped to free resources and allow
    power optimizations to take effect.

    CNM components:
    - Node.js server (port 3001)
    - PowerShell tray application (CNM-Tray.ps1)
    - Windows scheduled task (CNM-Server-Tray)
    """

    # Path to CNM control script (adjust if CNM is installed elsewhere)
    CNM_CONTROL_SCRIPT = Path(r"C:\Users\mtoli\Documents\Code\iphone bridge\startup\CNM-Control.ps1")

    def __init__(self):
        self._control_script_exists = self.CNM_CONTROL_SCRIPT.exists()

    def detect(self) -> dict[str, Any]:
        """Detect current CNM state."""
        result: dict[str, Any] = {
            "installed": self._control_script_exists,
            "server_running": False,
            "server_pid": None,
            "tray_running": False,
            "tray_pid": None,
            "task_enabled": False,
        }

        if not self._control_script_exists:
            return result

        try:
            # Run CNM-Control.ps1 -Status to get current state
            proc = subprocess.run(
                [
                    "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                    "-File", str(self.CNM_CONTROL_SCRIPT), "-Status"
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )

            output = proc.stdout

            # Parse output
            result["server_running"] = "Server: Running" in output
            result["tray_running"] = "Tray:   Running" in output
            result["task_enabled"] = "Task:   Enabled" in output

            # Extract PIDs if running
            for line in output.splitlines():
                if "Server: Running (PID" in line:
                    try:
                        pid_str = line.split("PID ")[1].rstrip(")")
                        result["server_pid"] = int(pid_str)
                    except (IndexError, ValueError):
                        pass
                elif "Tray:   Running (PID" in line:
                    try:
                        pid_str = line.split("PID ")[1].rstrip(")")
                        result["tray_pid"] = int(pid_str)
                    except (IndexError, ValueError):
                        pass

            # Check exit code (0 = running, 1 = stopped)
            result["is_active"] = proc.returncode == 0

        except subprocess.TimeoutExpired:
            logger.warning("Timeout detecting CNM status")
        except Exception as e:
            logger.debug(f"Failed to detect CNM status: {e}")

        return result

    def audit(self) -> list[Issue]:
        """Audit CNM state for gaming optimization."""
        issues: list[Issue] = []

        if not self._control_script_exists:
            # CNM not installed, nothing to audit
            return issues

        current = self.detect()

        if current.get("server_running") or current.get("tray_running"):
            issues.append(Issue(
                title="CNM relay server is running",
                severity=cast(SeverityType, "info"),
                current_value="Running",
                optimal_value="Stopped (for gaming)",
                explanation=(
                    "CNM (Celio's Network Machine) is running in the background. "
                    "It uses port 3001, keeps the system awake, and consumes resources. "
                    "Stopping it during gaming can improve performance and allow "
                    "power optimizations to work properly."
                ),
                category="cnm",
            ))

        return issues

    def apply(self, settings: dict[str, Any]) -> dict[str, Any]:
        """Apply CNM settings.

        Settings format:
        {
            "action": "stop" | "start" | "disable" | "enable"
        }

        Actions:
        - stop: Stop CNM server and tray (but keep scheduled task enabled)
        - start: Start CNM tray app (which auto-starts server)
        - disable: Stop CNM AND disable the scheduled task
        - enable: Enable scheduled task AND start CNM
        """
        errors: list[str] = []

        if not self._control_script_exists:
            return {
                "success": False,
                "error": f"CNM control script not found: {self.CNM_CONTROL_SCRIPT}",
                "requires_reboot": False,
            }

        action = settings.get("action", "stop")

        try:
            # Map action to CNM-Control.ps1 flags
            flag_map = {
                "stop": "-Stop",
                "start": "-Start",
                "disable": "-Disable",
                "enable": "-Enable",
            }

            flag = flag_map.get(action)
            if not flag:
                return {
                    "success": False,
                    "error": f"Unknown action: {action}",
                    "requires_reboot": False,
                }

            result = subprocess.run(
                [
                    "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                    "-File", str(self.CNM_CONTROL_SCRIPT), flag, "-Quiet"
                ],
                capture_output=True,
                text=True,
                timeout=30,
            )

            if result.returncode != 0:
                error_msg = result.stderr.strip() or result.stdout.strip() or "Unknown error"
                errors.append(f"CNM control failed: {error_msg}")

        except subprocess.TimeoutExpired:
            errors.append("Timeout running CNM control script")
        except Exception as e:
            errors.append(str(e))

        return {
            "success": len(errors) == 0,
            "error": "; ".join(errors) if errors else None,
            "requires_reboot": False,
        }

    def backup(self) -> dict[str, Any]:
        """Backup current CNM state."""
        return self.detect()

    def restore(self, data: dict[str, Any]) -> bool:
        """Restore CNM to previous state."""
        try:
            was_running = data.get("server_running") or data.get("tray_running")
            was_task_enabled = data.get("task_enabled", True)

            if was_running:
                # Restore to running state
                action = "enable" if was_task_enabled else "start"
            else:
                # Keep stopped
                action = "disable" if not was_task_enabled else "stop"

            result = self.apply({"action": action})
            return result.get("success", False)

        except Exception as e:
            logger.error(f"Failed to restore CNM state: {e}")
            return False
```

### 2. Add CNM Handler to Game Profiles

Modify each profile that should stop CNM during gaming. Add to the `get_handlers()` method and `get_settings()` method.

**Example modification for `abso/profiles/rivals2.py`:**

In `get_handlers()`, add the import and handler:

```python
def get_handlers(self) -> list[SettingsHandler]:
    from abso.settings.cnm import CNMSettingsHandler  # ADD THIS IMPORT
    from abso.settings.graphics import GraphicsSettingsHandler
    from abso.settings.memory import MemorySettingsHandler
    # ... other imports ...

    return [
        WindowsSettingsHandler(),
        PowerSettingsHandler(),
        # ... other handlers ...
        CNMSettingsHandler(),  # ADD THIS - stops CNM during gaming
    ]
```

In `get_settings()`, add the CNM settings:

```python
def get_settings(self, handler_name: str) -> dict[str, Any]:
    settings_map: dict[str, dict[str, Any]] = {
        # ... existing settings ...

        "CNMSettingsHandler": {
            "action": "stop",  # Stop CNM during gaming
            # Use "disable" to also disable the scheduled task
        },
    }

    return settings_map.get(handler_name, {})
```

### 3. Profiles to Modify

Add `CNMSettingsHandler` to these profiles (all competitive gaming profiles):

- `abso/profiles/rivals2.py` - Rivals of Aether 2
- `abso/profiles/slippi_melee.py` - Slippi Melee
- `abso/profiles/cod_bo7.py` - Call of Duty Black Ops 7
- `abso/profiles/diablo4.py` - Diablo 4 (optional, less latency-sensitive)
- `abso/profiles/pokemon_auto_chess.py` - Pokemon Auto Chess (optional)

### 4. Update the Issue Model (if needed)

Ensure the `Issue` model in `abso/core/models.py` supports the "cnm" category. If categories are validated, add "cnm" to the allowed list.

### 5. Add to Handler Registry (if applicable)

If ABSO has a handler registry or auto-discovery system, register `CNMSettingsHandler`:

```python
# In abso/settings/__init__.py or wherever handlers are registered
from abso.settings.cnm import CNMSettingsHandler

AVAILABLE_HANDLERS = [
    # ... existing handlers ...
    CNMSettingsHandler,
]
```

## CNM Control Script Reference

The `CNM-Control.ps1` script (already created in the CNM repo) provides these commands:

| Flag | Description |
|------|-------------|
| `-Stop` | Stop CNM server and tray app |
| `-Start` | Start CNM tray app (auto-starts server) |
| `-Status` | Check if CNM is running (exit 0 = running, 1 = stopped) |
| `-Disable` | Stop CNM AND disable the scheduled task |
| `-Enable` | Enable scheduled task AND start CNM |
| `-Quiet` | Suppress output (for scripting) |

**Location:** `C:\Users\mtoli\Documents\Code\iphone bridge\startup\CNM-Control.ps1`

## Testing

After implementing:

1. Run `python -m abso detect --handler cnm` to verify detection works
2. Run `python -m abso audit` to see if CNM appears as an optimization issue
3. Run `python -m abso apply --profile rivals2` to verify CNM stops
4. Run `python -m abso restore` to verify CNM restarts

## Notes

- CNM stopping is **non-destructive** - it can always be restarted
- The scheduled task remains enabled unless `-Disable` is used
- Backup/restore properly handles returning CNM to its previous state
- If CNM is not installed (control script not found), the handler silently skips

## File Locations Summary

| File | Purpose |
|------|---------|
| `abso/settings/cnm.py` | NEW - CNM settings handler |
| `abso/profiles/rivals2.py` | MODIFY - Add CNM handler |
| `abso/profiles/slippi_melee.py` | MODIFY - Add CNM handler |
| `abso/profiles/cod_bo7.py` | MODIFY - Add CNM handler |
| `C:\...\iphone bridge\startup\CNM-Control.ps1` | CNM control script (already exists) |
