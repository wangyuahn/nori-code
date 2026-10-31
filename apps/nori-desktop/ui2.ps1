$exe = "C:\Users\sudden\Desktop\Nori-Work-2.0.1-x64.exe"
$result = "C:\Users\sudden\AppData\Local\Temp\nori-ui2-result.txt"
if (Test-Path $result) { Remove-Item -Force $result }
Get-Process NoriWork -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$proc = Start-Process -FilePath $exe -ArgumentList "/S" -Wait -PassThru
$sw.Stop()
$lines = @()
$lines += ("exit=" + $proc.ExitCode + "s=" + [math]::Round($sw.Elapsed.TotalSeconds,1))
$lines += ("noriWeb=" + (Test-Path "C:\Program Files\NoriWork\resources\nori-web\dist\index.html"))
$lines | Out-File -FilePath $result -Encoding utf8
Start-Sleep -Seconds 2
Start-Process "C:\Program Files\NoriWork\NoriWork.exe"
