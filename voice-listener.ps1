param(
    [string]$CatName = "Bheduu",
    [string]$SettingsPath = ""
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Speech

try {
    $recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine
    $recognizer.SetInputToDefaultAudioDevice()

    $script:currentCatName = ""
    $script:lastSettingsMod = [DateTime]::MinValue

    function Load-CatGrammar([string]$nameToLoad) {
        $clean = $nameToLoad.Trim().ToLower()
        if (-not $clean) { $clean = "comnyang" }
        if ($clean -eq $script:currentCatName) { return }

        $script:currentCatName = $clean
        [Console]::WriteLine("UPDATING_CAT_NAME: " + $clean)

        $recognizer.UnloadAllGrammars()

        $staticChoices = New-Object System.Speech.Recognition.Choices
        $dynamicPrefixes = New-Object System.Speech.Recognition.Choices

        # 1. SUMMON / APPEAR CHOICES
        $summonWords = @(
            $clean,
            ("hey " + $clean),
            ("hi " + $clean),
            ("hello " + $clean),
            ("wake up " + $clean),
            "wake up",
            "hey cat",
            "hi cat",
            "hello cat",
            "come here",
            "show",
            "kittu",
            "hey kittu",
            "kitty",
            "comnyang",
            "bheduu",
            "hey bheduu"
        )
        $staticChoices.Add($summonWords)

        # 2. DISMISS / DISAPPEAR CHOICES
        $dismissWords = @(
            ("bye " + $clean),
            ("bye bye " + $clean),
            ("goodbye " + $clean),
            "bye",
            "bye bye",
            "goodbye",
            "bye cat",
            "bye bye cat",
            "goodbye cat",
            ("hide " + $clean),
            "hide",
            ("go away " + $clean),
            "go away",
            ("sleep " + $clean),
            "sleep",
            ("disappear " + $clean),
            "disappear",
            "bye bheduu",
            "hide bheduu"
        )
        $staticChoices.Add($dismissWords)

        # 3. COMMON APP & WEB OPEN COMMANDS
        $appCommands = @(
            "open youtube",
            "open youtube web",
            ($clean + " open youtube"),
            ($clean + " open youtube web"),
            ("hey " + $clean + " open youtube"),
            ("hey " + $clean + " open youtube web"),

            "open spotify",
            "open spotify web",
            ($clean + " open spotify"),
            ($clean + " open spotify web"),

            "open whatsapp",
            "open whatsapp web",
            ($clean + " open whatsapp"),
            ($clean + " open whatsapp web"),

            "open discord",
            "open discord web",
            ($clean + " open discord"),
            ($clean + " open discord web"),

            "open brave",
            ($clean + " open brave"),

            "open unstop",
            "open unstop web",
            ($clean + " open unstop"),

            "open classroom",
            "open google classroom",
            ($clean + " open classroom"),

            "open vs code",
            "open visual studio code",
            "open code",
            ($clean + " open code"),

            "open claude",
            "open chatgpt",
            "open github",
            "open notion",
            "open netflix",
            "open instagram",
            "open twitter",
            "open gmail",
            "open google"
        )
        $staticChoices.Add($appCommands)

        # 4. MEDIA CONTROLS
        $stopWords = @(
            "stop", "pause", "stop music", "pause music",
            ($clean + " stop"), ($clean + " pause"),
            ("hey " + $clean + " stop"), ("hey " + $clean + " pause"),
            "kittu stop", "kittu pause"
        )
        $staticChoices.Add($stopWords)

        # 5. DYNAMIC PREFIXES (FOR ARBITRARY APPS, SONGS, OR FOLLOW-UP QUESTIONS)
        $prefixes = @(
            "open",
            ($clean + " open"),
            ("hey " + $clean + " open"),
            "play",
            ($clean + " play"),
            ("hey " + $clean + " play"),
            "kittu play",
            ("hey " + $clean),
            ("hi " + $clean),
            ("hello " + $clean),
            $clean,
            "hey cat",
            "hi cat",
            "hello cat",
            "hey kittu",
            "kittu",
            "hey bheduu",
            "bheduu"
        )
        $dynamicPrefixes.Add($prefixes)

        # Load static commands grammar
        $staticGrammar = New-Object System.Speech.Recognition.Grammar($staticChoices)
        $staticGrammar.Name = "StaticCommands"
        $recognizer.LoadGrammar($staticGrammar)

        # Load dictation grammar for arbitrary "open ..." or "play ..." targets
        $gb = New-Object System.Speech.Recognition.GrammarBuilder
        $gb.Append($dynamicPrefixes)
        $gb.AppendDictation()
        $dynamicGrammar = New-Object System.Speech.Recognition.Grammar($gb)
        $dynamicGrammar.Name = "DynamicCommands"
        $recognizer.LoadGrammar($dynamicGrammar)

        [Console]::WriteLine("NAME_ADAPTED: " + $clean)
    }

    # Resolve initial cat name from settings.json if provided
    $initialName = $CatName
    if ($SettingsPath -and (Test-Path $SettingsPath)) {
        try {
            $json = Get-Content $SettingsPath -Raw | ConvertFrom-Json
            if ($json.catName -and $json.catName.Trim()) {
                $initialName = $json.catName.Trim()
            }
            $script:lastSettingsMod = (Get-Item $SettingsPath).LastWriteTimeUtc
        } catch {}
    }

    Load-CatGrammar $initialName

    # Signal to parent process that we started successfully
    [Console]::WriteLine("LISTENER_READY")

    # Speech recognition loop with dynamic settings watcher
    while ($true) {
        # Check if settings.json changed to adapt new cat name dynamically
        if ($SettingsPath -and (Test-Path $SettingsPath)) {
            try {
                $currentMod = (Get-Item $SettingsPath).LastWriteTimeUtc
                if ($currentMod -gt $script:lastSettingsMod) {
                    $script:lastSettingsMod = $currentMod
                    $json = Get-Content $SettingsPath -Raw | ConvertFrom-Json
                    if ($json.catName -and $json.catName.Trim() -and ($json.catName.Trim().ToLower() -ne $script:currentCatName)) {
                        Load-CatGrammar $json.catName.Trim()
                    }
                }
            } catch {}
        }

        try {
            $result = $recognizer.Recognize((New-Object TimeSpan(0, 0, 1)))
            if ($result -ne $null -and $result.Text.Trim() -ne "") {
                [Console]::WriteLine($result.Text.Trim())
            }
        } catch {
            Start-Sleep -Milliseconds 100
        }
    }
} catch {
    [Console]::WriteLine("LISTENER_ERROR: " + $_.Exception.Message)
}
