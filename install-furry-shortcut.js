"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function createShortcuts() {
  const projectDir = __dirname;
  const vbsPath = path.join(projectDir, "start-furry-silent.vbs");
  const iconPath = path.join(projectDir, "assets", "comnyang-logo.png");

  const getFolder = (folderName) => {
    try {
      const out = execSync(
        `powershell.exe -NoProfile -Command "[Environment]::GetFolderPath('${folderName}')"`,
        { encoding: "utf8" }
      ).trim();
      return out;
    } catch (_) {
      return null;
    }
  };

  const desktopDir = getFolder("Desktop");
  const startupDir = getFolder("Startup");

  console.log("Desktop folder:", desktopDir);
  console.log("Startup folder:", startupDir);

  const targets = [];
  if (desktopDir && fs.existsSync(desktopDir)) {
    targets.push({ name: "Desktop Shortcut", file: path.join(desktopDir, "Furry.lnk") });
  }
  if (startupDir && fs.existsSync(startupDir)) {
    targets.push({ name: "Windows Startup Shortcut", file: path.join(startupDir, "Furry.lnk") });
  }

  targets.forEach((t) => {
    const psScript = [
      `$wsh = New-Object -COM WScript.Shell;`,
      `$shortcut = $wsh.CreateShortcut('${t.file.replace(/'/g, "''")}');`,
      `$shortcut.TargetPath = 'wscript.exe';`,
      `$shortcut.Arguments = '"${vbsPath.replace(/"/g, '`"')} "';`,
      `$shortcut.WorkingDirectory = '${projectDir.replace(/'/g, "''")}';`,
      `$shortcut.Description = 'Furry Desktop Companion (Bheduu)';`,
      `if (Test-Path '${iconPath.replace(/'/g, "''")}') { $shortcut.IconLocation = '${iconPath.replace(/'/g, "''")}'; };`,
      `$shortcut.Save();`
    ].join(" ");

    try {
      execSync(`powershell.exe -NoProfile -Command "${psScript}"`, {
        stdio: "inherit",
      });
      console.log(`[SUCCESS] Created ${t.name} -> ${t.file}`);
    } catch (err) {
      console.error(`[ERROR] Failed to create ${t.name}:`, err.message);
    }
  });
}

createShortcuts();
