Dim WshShell, fso, currentDir
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Get current script directory
currentDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = currentDir

' Launch Furry desktop companion completely hidden (0 = no console window)
WshShell.Run "cmd /c npm start", 0, False
