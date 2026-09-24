; 安装目录跟手补全：目录页选中盘符根目录（D: / D:\）后，输入框立即补上
; ${APP_FILENAME} 子目录，所见即所装。上游 assistedInstaller.nsh 只在
; InstFiles 开始前静默追加应用子目录，目录页仍显示裸盘符；这里在
; .onVerifyInstDir 里同步改写 $INSTDIR 并刷新目录输入框（NSIS 目录页控件
; 1018）。手工输入途经盘符根时同样会补全，输入框可见且可继续编辑。
; 补全后再次触发的回调因路径已含 ${APP_FILENAME} 直接跳过，不会循环。
; 本文件被拼在模板 common.nsh 之前，LogicLib 必须自带（重复引入无害）；
; 不要在此 !define WinMessages.nsh 里的常量（如 WM_SETTEXT），会引起
; "already defined" 冲突，SendMessage 直接写消息值 0x000B。

!include "LogicLib.nsh"

Var codeWorkRecoveredInstall

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
      SendMessage $R2 0x000B 0 "STR:$INSTDIR"   ; WM_SETTEXT
    ${EndIf}
  ${EndIf}
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

; 旧版原生模块被其他进程占用时，上游卸载器会以错误码 2 退出。此时不要
; 覆盖旧目录；在同级空目录安装新版，并让后续注册表和快捷方式指向新版。
; 保留旧目录供用户在占用解除后清理，也避免静默更新卡在错误弹窗。
!macro codeWorkRecoverFailedUninstall
  ${If} ${Errors}
    DetailPrint "Previous uninstaller could not be launched"
  ${ElseIf} $R0 == 2
    StrCpy $R1 0
    StrCpy $R2 "$INSTDIR-v${VERSION}"
    ${Do}
      ${IfNot} ${FileExists} "$R2"
        ${ExitDo}
      ${EndIf}
      IntOp $R1 $R1 + 1
      ${If} $R1 > 9
        DetailPrint "No free directory for upgrade recovery"
        SetErrorLevel 2
        Quit
      ${EndIf}
      StrCpy $R2 "$INSTDIR-v${VERSION}-$R1"
    ${Loop}

    DetailPrint "Previous version could not be removed (code $R0); installing to $R2"
    StrCpy $INSTDIR "$R2"
    StrCpy $appExe "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    StrCpy $codeWorkRecoveredInstall "true"
    StrCpy $R0 0
  ${ElseIf} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
    DetailPrint "Previous uninstaller failed with code $R0"
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customUnInstallCheck
  !insertmacro codeWorkRecoverFailedUninstall
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro codeWorkRecoverFailedUninstall
!macroend

; 上游保留快捷方式时不会改写目标。仅重定向原本存在的快捷方式，
; 避免恢复安装后仍启动旧版，也不重新创建用户已删除的桌面图标。
!macro customInstall
  ${If} $codeWorkRecoveredInstall == "true"
  ${AndIf} $keepShortcuts == "true"
    ${If} ${FileExists} "$newStartMenuLink"
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${EndIf}
    ${If} ${FileExists} "$newDesktopLink"
      CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    ${EndIf}
  ${EndIf}
!macroend
