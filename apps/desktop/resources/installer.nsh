; 安装目录跟手补全：目录页选中盘符根目录（D: / D:\）后，输入框立即补上
; ${APP_FILENAME} 子目录，所见即所装。上游 assistedInstaller.nsh 只在
; InstFiles 开始前静默追加应用子目录，目录页仍显示裸盘符；这里在
; .onVerifyInstDir 里同步改写 $INSTDIR 并刷新目录输入框（NSIS 目录页控件
; 1018）。手工输入途经盘符根时同样会补全，输入框可见且可继续编辑。
; 补全后再次触发的回调因路径已含 ${APP_FILENAME} 直接跳过，不会循环。
; 本文件被拼在模板 common.nsh 之前，LogicLib 必须自带（重复引入无害）。

!include "LogicLib.nsh"

!ifndef WM_SETTEXT
  !define WM_SETTEXT 0x000B
!endif

Function .onVerifyInstDir
  Push $R0
  Push $R1
  Push $R2
  StrCpy $R0 "$INSTDIR" 1   ; 盘符
  StrCpy $R1 "$INSTDIR" 2   ; "D:"
  StrCpy $R2 "$INSTDIR" 3   ; "D:\"
  ${If} $R1 == "$R0:"
  ${AndIf} $INSTDIR != "$R1\${APP_FILENAME}"
    ${If} $INSTDIR == "$R1"
    ${OrIf} $INSTDIR == "$R2"
      StrCpy $INSTDIR "$R1\${APP_FILENAME}"
      GetDlgItem $R2 $HWNDPARENT 1018
      SendMessage $R2 ${WM_SETTEXT} 0 "STR:$INSTDIR"
    ${EndIf}
  ${EndIf}
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd
