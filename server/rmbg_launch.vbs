' rmbg_launch.vbs
' Legge i parametri da un file JSON passato come argomento,
' lancia rmbg_process.py in background senza aspettare.
' Chiamato da After Effects via: wscript rmbg_launch.vbs "job.json"

Option Explicit

Dim fso, jobFile, jobPath, jsonTxt
Dim python_exe, script_path, input_f, output_f, status_f, log_f
Dim model_name, mask_expand, mask_blur, invert_mask, comfyui_path
Dim cmd, WshShell

Set fso = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")

' Leggi il percorso del file job JSON dall'argomento
If WScript.Arguments.Count = 0 Then
    WScript.Echo "Usage: wscript rmbg_launch.vbs <job.json>"
    WScript.Quit 1
End If

jobPath = WScript.Arguments(0)

If Not fso.FileExists(jobPath) Then
    WScript.Echo "Job file not found: " & jobPath
    WScript.Quit 1
End If

' Leggi il JSON (parsing minimale per chiavi semplici)
Set jobFile = fso.OpenTextFile(jobPath, 1)
jsonTxt = jobFile.ReadAll
jobFile.Close

Function ExtractJSON(json, key)
    Dim pattern, pos, valStart, valEnd, val
    pattern = Chr(34) & key & Chr(34) & ":"
    pos = InStr(json, pattern)
    If pos = 0 Then
        ExtractJSON = ""
        Exit Function
    End If
    pos = pos + Len(pattern)
    ' Skip whitespace
    Do While Mid(json, pos, 1) = " " Or Mid(json, pos, 1) = Chr(9)
        pos = pos + 1
    Loop
    If Mid(json, pos, 1) = Chr(34) Then
        ' String value
        pos = pos + 1
        valEnd = InStr(pos, json, Chr(34))
        ExtractJSON = Mid(json, pos, valEnd - pos)
    Else
        ' Number or boolean
        valEnd = pos
        Do While Mid(json, valEnd, 1) <> "," And Mid(json, valEnd, 1) <> "}" And valEnd <= Len(json)
            valEnd = valEnd + 1
        Loop
        ExtractJSON = Trim(Mid(json, pos, valEnd - pos))
    End If
End Function

python_exe   = ExtractJSON(jsonTxt, "python_exe")
script_path  = ExtractJSON(jsonTxt, "script_path")
input_f      = ExtractJSON(jsonTxt, "input")
output_f     = ExtractJSON(jsonTxt, "output")
status_f     = ExtractJSON(jsonTxt, "status")
log_f        = ExtractJSON(jsonTxt, "log")
model_name   = ExtractJSON(jsonTxt, "model")
mask_expand  = ExtractJSON(jsonTxt, "mask_expand")
mask_blur    = ExtractJSON(jsonTxt, "mask_blur")
invert_mask  = ExtractJSON(jsonTxt, "invert_mask")
comfyui_path = ExtractJSON(jsonTxt, "comfyui_path")

' Costruisci il comando
cmd = Chr(34) & python_exe & Chr(34) & " " & _
      Chr(34) & script_path & Chr(34) & _
      " --input "    & Chr(34) & input_f    & Chr(34) & _
      " --output "   & Chr(34) & output_f   & Chr(34) & _
      " --status "   & Chr(34) & status_f   & Chr(34) & _
      " --model "    & Chr(34) & model_name & Chr(34) & _
      " --comfyui "  & Chr(34) & comfyui_path & Chr(34) & _
      " --mask_expand " & mask_expand & _
      " --mask_blur "   & mask_blur

If invert_mask = "true" Then
    cmd = cmd & " --invert"
End If

cmd = cmd & " >> " & Chr(34) & log_f & Chr(34) & " 2>&1"

' Lancia in background (0=nascosto, False=non aspettare)
WshShell.Run "cmd /C " & Chr(34) & cmd & Chr(34), 0, False

' Pulisci il file job JSON
fso.DeleteFile jobPath
