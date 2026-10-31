$inner = "C:\Users\sudden\Desktop\nori-code\nori-workspace\apps\nori-desktop\ui2.ps1"
$result = "C:\Users\sudden\AppData\Local\Temp\nori-ui2-result.txt"
if (Test-Path $result) { Remove-Item -Force $result }
$proc = Start-Process -FilePath "powershell" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$inner`"" -Verb RunAs -Wait -PassThru
Write-Output ("elevated exit=" + $proc.ExitCode)
if (Test-Path $result) { Get-Content $result } else { Write-Output "no result" }
