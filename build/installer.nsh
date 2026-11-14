; 覆盖安装时顺手清掉上一版下载的安装包与分段缓存。
; 安装器自身可能就是从这个目录启动的，正被占用的文件删不掉会跳过，
; 下次启动时 housekeeping.mjs 会补上（那时安装器已经退出）。

!macro customInstall
  RMDir /r "$APPDATA\huajing\updates"
!macroend
