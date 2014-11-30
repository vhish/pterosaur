// -*- coding: utf-8 -*-
// vim: et:ts=4:sw=4:sts=4:ft=javascript
/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public
 * License Version 1.1 (the "MPL"); you may not use this file
 * except in compliance with the MPL. You may obtain a copy of
 * the MPL at http://www.mozilla.org/MPL/
 *
 * Software distributed under the MPL is distributed on an "AS
 * IS" basis, WITHOUT WARRANTY OF ANY KIND, either express or
 * implied. See the MPL for the specific language governing
 * rights and limitations under the MPL.
 *
 * The Original Code is subprocess.jsm.
 *
 * The Initial Developer of this code is Jan Gerber.
 * Portions created by Jan Gerber <j@mailb.org>
 * are Copyright (C) 2011 Jan Gerber.
 * All Rights Reserved.
 *
 * Contributor(s):
 * Patrick Brunschwig <patrick@enigmail.net>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 * ***** END LICENSE BLOCK ***** */

/*
 * Import into a JS component using
 * 'Components.utils.import("resource://firefogg/subprocess.jsm");'
 *
 * This object allows to start a process, and read/write data to/from it
 * using stdin/stdout/stderr streams.
 * Usage example:
 *
 *  var p = subprocess.call({
 *    command:     '/bin/foo',
 *    arguments:   ['-v', 'foo'],
 *    environment: [ "XYZ=abc", "MYVAR=def" ],
 *    charset: 'UTF-8',
 *    workdir: '/home/foo',
 *    //stdin: "some value to write to stdin\nfoobar",
 *    stdin: function(stdin) {
 *      stdin.write("some value to write to stdin\nfoobar");
 *      stdin.close();
 *    },
 *    stdout: function(data) {
 *      dump("got data on stdout:" + data + "\n");
 *    },
 *    stderr: function(data) {
 *      dump("got data on stderr:" + data + "\n");
 *    },
 *    done: function(result) {
 *      dump("process terminated with " + result.exitCode + "\n");
 *    },
 *    mergeStderr: false
 *  });
 *  p.wait(); // wait for the subprocess to terminate
 *            // this will block the main thread,
 *            // only do if you can wait that long
 *
 *
 * Description of parameters:
 * --------------------------
 * Apart from <command>, all arguments are optional.
 *
 * command:     either a |nsIFile| object pointing to an executable file or a
 *              String containing the platform-dependent path to an executable
 *              file.
 *
 * arguments:   optional string array containing the arguments to the command.
 *
 * environment: optional string array containing environment variables to pass
 *              to the command. The array elements must have the form
 *              "VAR=data". Please note that if environment is defined, it
 *              replaces any existing environment variables for the subprocess.
 *
 * charset:     Output is decoded with given charset and a string is returned.
 *              If charset is undefined, "UTF-8" is used as default.
 *              To get binary data, set this explicitly to null and the
 *              returned string is not decoded in any way.
 *
 * workdir:     optional; String containing the platform-dependent path to a
 *              directory to become the current working directory of the subprocess.
 *
 * stdin:       optional input data for the process to be passed on standard
 *              input. stdin can either be a string or a function.
 *              A |string| gets written to stdin and stdin gets closed;
 *              A |function| gets passed an object with write and close function.
 *              Please note that the write() function will return almost immediately;
 *              data is always written asynchronously on a separate thread.
 *
 * stdout:      an optional function that can receive output data from the
 *              process. The stdout-function is called asynchronously; it can be
 *              called mutliple times during the execution of a process.
 *              At a minimum at each occurance of \n or \r.
 *              Please note that null-characters might need to be escaped
 *              with something like 'data.replace(/\0/g, "\\0");'.
 *
 * stderr:      an optional function that can receive stderr data from the
 *              process. The stderr-function is called asynchronously; it can be
 *              called mutliple times during the execution of a process. Please
 *              note that null-characters might need to be escaped with
 *              something like 'data.replace(/\0/g, "\\0");'.
 *              (on windows it only gets called once right now)
 *
 * done:        optional function that is called when the process has terminated.
 *              The exit code from the process available via result.exitCode. If
 *              stdout is not defined, then the output from stdout is available
 *              via result.stdout. stderr data is in result.stderr
 *
 * mergeStderr: optional boolean value. If true, stderr is merged with stdout;
 *              no data will be provided to stderr. Default is false.
 *
 * bufferedOutput: optional boolean value. If true, stderr and stdout are buffered
 *              and will only deliver data when a certain amount of output is
 *              available. Enabling the option will give you some performance
 *              benefits if your read a lot of data. Don't enable this if your
 *              application works in a conversation-like mode. Default is false.
 *
 *
 * Description of object returned by subprocess.call(...)
 * ------------------------------------------------------
 * The object returned by subprocess.call offers a few methods that can be
 * executed:
 *
 * wait():         waits for the subprocess to terminate. It is not required to use
 *                 wait; done will be called in any case when the subprocess terminated.
 *
 * kill(hardKill): kill the subprocess. Any open pipes will be closed and
 *                 done will be called.
 *                 hardKill [ignored on Windows]:
 *                  - false: signal the process terminate (SIGTERM)
 *                  - true:  kill the process (SIGKILL)
 *
 *
 * Other methods in subprocess
 * ---------------------------
 *
 * registerDebugHandler(functionRef):   register a handler that is called to get
 *                                      debugging information
 * registerLogHandler(functionRef):     register a handler that is called to get error
 *                                      messages
 *
 * example:
 *    subprocess.registerLogHandler( function(s) { dump(s); } );
 */

'use strict';

Components.utils.import("resource://gre/modules/ctypes.jsm");

let EXPORTED_SYMBOLS = [ "subprocess" ];

const Cc = Components.classes;
const Ci = Components.interfaces;

const NS_LOCAL_FILE = "@mozilla.org/file/local;1";


//Windows API definitions
if (ctypes.size_t.size == 8) {
    var WinABI = ctypes.default_abi;
} else {
    var WinABI = ctypes.winapi_abi;
}
const WORD = ctypes.uint16_t;
const DWORD = ctypes.uint32_t;
const LPDWORD = DWORD.ptr;

const UINT = ctypes.unsigned_int;
const BOOL = ctypes.bool;
const HANDLE = ctypes.size_t;
const HWND = HANDLE;
const HMODULE = HANDLE;
const WPARAM = ctypes.size_t;
const LPARAM = ctypes.size_t;
const LRESULT = ctypes.size_t;
const ULONG_PTR = ctypes.uintptr_t;
const PVOID = ctypes.voidptr_t;
const LPVOID = PVOID;
const LPCTSTR = ctypes.jschar.ptr;
const LPCWSTR = ctypes.jschar.ptr;
const LPTSTR = ctypes.jschar.ptr;
const LPSTR = ctypes.char.ptr;
const LPCSTR = ctypes.char.ptr;
const LPBYTE = ctypes.char.ptr;

const CREATE_NEW_CONSOLE = 0x00000010;
const CREATE_NO_WINDOW = 0x08000000;
const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
const STARTF_USESHOWWINDOW = 0x00000001;
const STARTF_USESTDHANDLES = 0x00000100;
const SW_HIDE = 0;
const DUPLICATE_SAME_ACCESS = 0x00000002;
const STILL_ACTIVE = 259;
const INFINITE = DWORD(0xFFFFFFFF);
const WAIT_TIMEOUT = 0x00000102;

/*
typedef struct _SECURITY_ATTRIBUTES {
 DWORD  nLength;
 LPVOID lpSecurityDescriptor;
 BOOL   bInheritHandle;
} SECURITY_ATTRIBUTES, *PSECURITY_ATTRIBUTES, *LPSECURITY_ATTRIBUTES;
*/
const SECURITY_ATTRIBUTES = new ctypes.StructType("SECURITY_ATTRIBUTES", [
    {"nLength": DWORD},
    {"lpSecurityDescriptor": LPVOID},
    {"bInheritHandle": BOOL}
]);

/*
typedef struct _STARTUPINFO {
  DWORD  cb;
  LPTSTR lpReserved;
  LPTSTR lpDesktop;
  LPTSTR lpTitle;
  DWORD  dwX;
  DWORD  dwY;
  DWORD  dwXSize;
  DWORD  dwYSize;
  DWORD  dwXCountChars;
  DWORD  dwYCountChars;
  DWORD  dwFillAttribute;
  DWORD  dwFlags;
  WORD   wShowWindow;
  WORD   cbReserved2;
  LPBYTE lpReserved2;
  HANDLE hStdInput;
  HANDLE hStdOutput;
  HANDLE hStdError;
} STARTUPINFO, *LPSTARTUPINFO;
*/
const STARTUPINFO = new ctypes.StructType("STARTUPINFO", [
    {"cb": DWORD},
    {"lpReserved": LPTSTR},
    {"lpDesktop": LPTSTR},
    {"lpTitle": LPTSTR},
    {"dwX": DWORD},
    {"dwY": DWORD},
    {"dwXSize": DWORD},
    {"dwYSize": DWORD},
    {"dwXCountChars": DWORD},
    {"dwYCountChars": DWORD},
    {"dwFillAttribute": DWORD},
    {"dwFlags": DWORD},
    {"wShowWindow": WORD},
    {"cbReserved2": WORD},
    {"lpReserved2": LPBYTE},
    {"hStdInput": HANDLE},
    {"hStdOutput": HANDLE},
    {"hStdError": HANDLE}
]);

/*
typedef struct _PROCESS_INFORMATION {
  HANDLE hProcess;
  HANDLE hThread;
  DWORD  dwProcessId;
  DWORD  dwThreadId;
} PROCESS_INFORMATION, *LPPROCESS_INFORMATION;
*/
const PROCESS_INFORMATION = new ctypes.StructType("PROCESS_INFORMATION", [
    {"hProcess": HANDLE},
    {"hThread": HANDLE},
    {"dwProcessId": DWORD},
    {"dwThreadId": DWORD}
]);

/*
typedef struct _OVERLAPPED {
  ULONG_PTR Internal;
  ULONG_PTR InternalHigh;
  union {
    struct {
      DWORD Offset;
      DWORD OffsetHigh;
    };
    PVOID  Pointer;
  };
  HANDLE    hEvent;
} OVERLAPPED, *LPOVERLAPPED;
*/
const OVERLAPPED = new ctypes.StructType("OVERLAPPED");

//UNIX definitions
const pid_t = ctypes.int32_t;
const WNOHANG = 1;
const F_GETFD = 1;
const F_SETFL = 4;

const LIBNAME       = 0;
const O_NONBLOCK    = 1;
const RLIM_T        = 2;
const RLIMIT_NOFILE = 3;

function getPlatformValue(valueType) {

    if (! gXulRuntime)
        gXulRuntime = Cc["@mozilla.org/xre/app-info;1"].getService(Ci.nsIXULRuntime);

    const platformDefaults = {
        // Windows API:
        'winnt':   [ 'kernel32.dll' ],

        // Unix API:
        //            library name   O_NONBLOCK RLIM_T                RLIMIT_NOFILE
        'darwin':  [ 'libc.dylib',   0x04     , ctypes.uint64_t     , 8 ],
        'linux':   [ 'libc.so.6',    2024     , ctypes.unsigned_long, 7 ],
        'freebsd': [ 'libc.so.7',    0x04     , ctypes.int64_t      , 8 ],
        'openbsd': [ 'libc.so.61.0', 0x04     , ctypes.int64_t      , 8 ],
        'sunos':   [ 'libc.so',      0x80     , ctypes.unsigned_long, 5 ]
    };

    return platformDefaults[gXulRuntime.OS.toLowerCase()][valueType];
}


var gDebugFunc = null,
    gLogFunc = null,
    gXulRuntime = null;

function LogError(s) {
    if (gLogFunc)
        gLogFunc(s);
    else
        dump(s);
}

function debugLog(s) {
    if (gDebugFunc)
        gDebugFunc(s);
}

function setTimeout(callback, timeout) {
    var timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    timer.initWithCallback(callback, timeout, Ci.nsITimer.TYPE_ONE_SHOT);
};

function convertBytes(data, charset) {
    var string = '';
    charset = charset || 'UTF-8';
    var unicodeConv = Cc["@mozilla.org/intl/scriptableunicodeconverter"]
                        .getService(Ci.nsIScriptableUnicodeConverter);
    try {
        unicodeConv.charset = charset;
        string = unicodeConv.ConvertToUnicode(data);
    } catch (ex) {
        LogError("String conversion failed: "+ex.toString()+"\n");
        string = '';
    }
    string += unicodeConv.Finish();
    return string;
}

function getCommandStr(command) {
    let commandStr = null;
    if (typeof(command) == "string") {
        let file = Cc[NS_LOCAL_FILE].createInstance(Ci.nsIFile);
        file.initWithPath(command);
        if (! (file.isExecutable() && file.isFile()))
            throw("File '"+command+"' is not an executable file");
        commandStr = command;
    }
    else {
        if (! (command.isExecutable() && command.isFile()))
            throw("File '"+command.path+"' is not an executable file");
        commandStr = command.path;
    }

    return commandStr;
}

function getWorkDir(workdir) {
    let workdirStr = null;
    if (typeof(workdir) == "string") {
        let file = Cc[NS_LOCAL_FILE].createInstance(Ci.nsIFile);
        file.initWithPath(workdir);
        if (! (file.isDirectory()))
            throw("Directory '"+workdir+"' does not exist");
        workdirStr = workdir;
    }
    else if (workdir) {
        if (! workdir.isDirectory())
            throw("Directory '"+workdir.path+"' does not exist");
        workdirStr = workdir.path;
    }
    return workdirStr;
}


var subprocess = {
    call: function(options) {
        URL = options.url;
        options.mergeStderr = options.mergeStderr || false;
        options.bufferedOutput = options.bufferedOutput || false;
        options.workdir = options.workdir ||  null;
        options.environment = options.environment ||  [];
        if (options.arguments) {
            var args = options.arguments;
            options.arguments = [];
            args.forEach(function(argument) {
                options.arguments.push(argument);
            });
        } else {
            options.arguments = [];
        }

        options.libc = getPlatformValue(LIBNAME);

        if (gXulRuntime.OS.substring(0, 3) == "WIN") {
            return subprocess_win32(options);
        } else {
            return subprocess_unix(options);
        }

    },
    registerDebugHandler: function(func) {
        gDebugFunc = func;
    },
    registerLogHandler: function(func) {
        gLogFunc = func;
    },

    getPlatformValue: getPlatformValue
};



function subprocess_win32(options) {
    var kernel32dll = ctypes.open(options.libc),
        hChildProcess,
        active = true,
        done = false,
        exitCode = -1,
        child = {},
        stdinWorker = null,
        stdoutWorker = null,
        stderrWorker = null,
        pendingWriteCount = 0,
        readers = 2,
        stdinOpenState = 2,
        error = '',
        output = '';

    // stdin pipe states
    const OPEN = 2;
    const CLOSEABLE = 1;
    const CLOSED = 0;

    //api declarations
    /*
    BOOL WINAPI CloseHandle(
      __in  HANDLE hObject
    );
    */
    var CloseHandle = kernel32dll.declare("CloseHandle",
                                            WinABI,
                                            BOOL,
                                            HANDLE
    );

    /*
    BOOL WINAPI CreateProcess(
      __in_opt     LPCTSTR lpApplicationName,
      __inout_opt  LPTSTR lpCommandLine,
      __in_opt     LPSECURITY_ATTRIBUTES lpProcessAttributes,
      __in_opt     LPSECURITY_ATTRIBUTES lpThreadAttributes,
      __in         BOOL bInheritHandles,
      __in         DWORD dwCreationFlags,
      __in_opt     LPVOID lpEnvironment,
      __in_opt     LPCTSTR lpCurrentDirectory,
      __in         LPSTARTUPINFO lpStartupInfo,
      __out        LPPROCESS_INFORMATION lpProcessInformation
    );
     */
    var CreateProcessW = kernel32dll.declare("CreateProcessW",
                                            WinABI,
                                            BOOL,
                                            LPCTSTR,
                                            LPTSTR,
                                            SECURITY_ATTRIBUTES.ptr,
                                            SECURITY_ATTRIBUTES.ptr,
                                            BOOL,
                                            DWORD,
                                            LPVOID,
                                            LPCTSTR,
                                            STARTUPINFO.ptr,
                                            PROCESS_INFORMATION.ptr
                                         );

//     /*
//     BOOL WINAPI ReadFile(
//       __in         HANDLE hFile,
//       __out        LPVOID ReadFileBuffer,
//       __in         DWORD nNumberOfBytesToRead,
//       __out_opt    LPDWORD lpNumberOfBytesRead,
//       __inout_opt  LPOVERLAPPED lpOverlapped
//     );
//     */
//     var ReadFileBufferSize = 1024,
//         ReadFileBuffer = ctypes.char.array(ReadFileBufferSize),
//         ReadFile = kernel32dll.declare("ReadFile",
//                                         WinABI,
//                                         BOOL,
//                                         HANDLE,
//                                         ReadFileBuffer,
//                                         DWORD,
//                                         LPDWORD,
//                                         OVERLAPPED.ptr
//     );
//
//     /*
//     BOOL WINAPI PeekNamedPipe(
//       __in       HANDLE hNamedPipe,
//       __out_opt  LPVOID lpBuffer,
//       __in       DWORD nBufferSize,
//       __out_opt  LPDWORD lpBytesRead,
//       __out_opt  LPDWORD lpTotalBytesAvail,
//       __out_opt  LPDWORD lpBytesLeftThisMessage
//     );
//     */
//     var PeekNamedPipe = kernel32dll.declare("PeekNamedPipe",
//                                         WinABI,
//                                         BOOL,
//                                         HANDLE,
//                                         ReadFileBuffer,
//                                         DWORD,
//                                         LPDWORD,
//                                         LPDWORD,
//                                         LPDWORD
//     );
//
//     /*
//     BOOL WINAPI WriteFile(
//       __in         HANDLE hFile,
//       __in         LPCVOID lpBuffer,
//       __in         DWORD nNumberOfBytesToWrite,
//       __out_opt    LPDWORD lpNumberOfBytesWritten,
//       __inout_opt  LPOVERLAPPED lpOverlapped
//     );
//     */
//     var WriteFile = kernel32dll.declare("WriteFile",
//                                         WinABI,
//                                         BOOL,
//                                         HANDLE,
//                                         ctypes.char.ptr,
//                                         DWORD,
//                                         LPDWORD,
//                                         OVERLAPPED.ptr
//     );

    /*
    BOOL WINAPI CreatePipe(
      __out     PHANDLE hReadPipe,
      __out     PHANDLE hWritePipe,
      __in_opt  LPSECURITY_ATTRIBUTES lpPipeAttributes,
      __in      DWORD nSize
    );
    */
    var CreatePipe = kernel32dll.declare("CreatePipe",
                                        WinABI,
                                        BOOL,
                                        HANDLE.ptr,
                                        HANDLE.ptr,
                                        SECURITY_ATTRIBUTES.ptr,
                                        DWORD
    );

    /*
    HANDLE WINAPI GetCurrentProcess(void);
    */
    var GetCurrentProcess = kernel32dll.declare("GetCurrentProcess",
                                        WinABI,
                                        HANDLE
    );

    /*
    DWORD WINAPI GetLastError(void);
    */
    var GetLastError = kernel32dll.declare("GetLastError",
                                        WinABI,
                                        DWORD
    );

    /*
    BOOL WINAPI DuplicateHandle(
      __in   HANDLE hSourceProcessHandle,
      __in   HANDLE hSourceHandle,
      __in   HANDLE hTargetProcessHandle,
      __out  LPHANDLE lpTargetHandle,
      __in   DWORD dwDesiredAccess,
      __in   BOOL bInheritHandle,
      __in   DWORD dwOptions
    );
    */
    var DuplicateHandle = kernel32dll.declare("DuplicateHandle",
                                        WinABI,
                                        BOOL,
                                        HANDLE,
                                        HANDLE,
                                        HANDLE,
                                        HANDLE.ptr,
                                        DWORD,
                                        BOOL,
                                        DWORD
    );


    /*
    BOOL WINAPI GetExitCodeProcess(
      __in   HANDLE hProcess,
      __out  LPDWORD lpExitCode
    );
    */
    var GetExitCodeProcess = kernel32dll.declare("GetExitCodeProcess",
                                        WinABI,
                                        BOOL,
                                        HANDLE,
                                        LPDWORD
    );

    /*
    DWORD WINAPI WaitForSingleObject(
      __in  HANDLE hHandle,
      __in  DWORD dwMilliseconds
    );
    */
    var WaitForSingleObject = kernel32dll.declare("WaitForSingleObject",
                                        WinABI,
                                        DWORD,
                                        HANDLE,
                                        DWORD
    );

    /*
    BOOL WINAPI TerminateProcess(
      __in  HANDLE hProcess,
      __in  UINT uExitCode
    );
    */
    var TerminateProcess = kernel32dll.declare("TerminateProcess",
                                        WinABI,
                                        BOOL,
                                        HANDLE,
                                        UINT
    );

    //functions
    function popen(command, workdir, args, environment, child) {
        //escape arguments
        args.unshift(command);
        for (var i = 0; i < args.length; i++) {
          if (typeof args[i] != "string") { args[i] = args[i].toString(); }
          /* quote arguments with spaces */
          if (args[i].match(/\s/)) {
            args[i] = "\"" + args[i] + "\"";
          }
          /* If backslash is followed by a quote, double it */
          args[i] = args[i].replace(/\\\"/g, "\\\\\"");
        }
        command = args.join(' ');

        environment = environment || [];
        if(environment.length) {
            //An environment block consists of
            //a null-terminated block of null-terminated strings.
            //Using CREATE_UNICODE_ENVIRONMENT so needs to be jschar
            environment = ctypes.jschar.array()(environment.join('\0') + '\0');
        } else {
            environment = null;
        }

        var hOutputReadTmp = new HANDLE(),
            hOutputRead = new HANDLE(),
            hOutputWrite = new HANDLE();

        var hErrorRead = new HANDLE(),
            hErrorReadTmp = new HANDLE(),
            hErrorWrite = new HANDLE();

        var hInputRead = new HANDLE(),
            hInputWriteTmp = new HANDLE(),
            hInputWrite = new HANDLE();

        // Set up the security attributes struct.
        var sa = new SECURITY_ATTRIBUTES();
        sa.nLength = SECURITY_ATTRIBUTES.size;
        sa.lpSecurityDescriptor = null;
        sa.bInheritHandle = true;

        // Create output pipe.

        if(!CreatePipe(hOutputReadTmp.address(), hOutputWrite.address(), sa.address(), 0))
            LogError('CreatePipe hOutputReadTmp failed');

        // Create error pipe.
        if(!CreatePipe(hErrorReadTmp.address(), hErrorWrite.address(), sa.address(), 0))
            LogError('CreatePipe hErrorReadTmp failed');

        // Create input pipe.
        if (!CreatePipe(hInputRead.address(),hInputWriteTmp.address(),sa.address(), 0))
            LogError("CreatePipe hInputRead failed");

        // Create new output/error read handle and the input write handles. Set
        // the Properties to FALSE. Otherwise, the child inherits the
        // properties and, as a result, non-closeable handles to the pipes
        // are created.
        if (!DuplicateHandle(GetCurrentProcess(), hOutputReadTmp,
                             GetCurrentProcess(),
                             hOutputRead.address(), // Address of new handle.
                             0, false, // Make it uninheritable.
                             DUPLICATE_SAME_ACCESS))
             LogError("DupliateHandle hOutputReadTmp failed");

        if (!DuplicateHandle(GetCurrentProcess(), hErrorReadTmp,
                         GetCurrentProcess(),
                         hErrorRead.address(), // Address of new handle.
                         0, false, // Make it uninheritable.
                         DUPLICATE_SAME_ACCESS))
         LogError("DupliateHandle hErrorReadTmp failed");

        if (!DuplicateHandle(GetCurrentProcess(), hInputWriteTmp,
                             GetCurrentProcess(),
                             hInputWrite.address(), // Address of new handle.
                             0, false, // Make it uninheritable.
                             DUPLICATE_SAME_ACCESS))
          LogError("DupliateHandle hInputWriteTmp failed");

        // Close inheritable copies of the handles.
        if (!CloseHandle(hOutputReadTmp)) LogError("CloseHandle hOutputReadTmp failed");
        if (!CloseHandle(hErrorReadTmp)) LogError("CloseHandle hErrorReadTmp failed");
        if (!CloseHandle(hInputWriteTmp)) LogError("CloseHandle failed");

        var pi = new PROCESS_INFORMATION();
        var si = new STARTUPINFO();

        si.cb = STARTUPINFO.size;
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput  = hInputRead;
        si.hStdOutput = hOutputWrite;
        si.hStdError  = hErrorWrite;

        // Launch the process
        if(!CreateProcessW(null,            // executable name
                           command,         // command buffer
                           null,            // process security attribute
                           null,            // thread security attribute
                           true,            // inherits system handles
                           CREATE_UNICODE_ENVIRONMENT|CREATE_NO_WINDOW, // process flags
                           environment,     // envrionment block
                           workdir,          // set as current directory
                           si.address(),    // (in) startup information
                           pi.address()     // (out) process information
        ))
            throw("Fatal - Could not launch subprocess '"+command+"'");

        // Close any unnecessary handles.
        if (!CloseHandle(pi.hThread))
            LogError("CloseHandle pi.hThread failed");

        // Close pipe handles (do not continue to modify the parent).
        // You need to make sure that no handles to the write end of the
        // output pipe are maintained in this process or else the pipe will
        // not close when the child process exits and the ReadFile will hang.
        if (!CloseHandle(hInputRead)) LogError("CloseHandle hInputRead failed");
        if (!CloseHandle(hOutputWrite)) LogError("CloseHandle hOutputWrite failed");
        if (!CloseHandle(hErrorWrite)) LogError("CloseHandle hErrorWrite failed");

        //return values
        child.stdin = hInputWrite;
        child.stdout = hOutputRead;
        child.stderr = hErrorRead;
        child.process = pi.hProcess;
        return pi.hProcess;
    }

    /*
     * createStdinWriter ()
     *
     * Create a ChromeWorker object for writing data to the subprocess' stdin
     * pipe. The ChromeWorker object lives on a separate thread; this avoids
     * internal deadlocks.
     */
    function createStdinWriter() {
        debugLog("Creating new stdin worker\n");
        stdinWorker = new ChromeWorker("subprocess_worker_win.js");
        stdinWorker.onmessage = function(event) {
            switch(event.data) {
            case "WriteOK":
                pendingWriteCount--;
                debugLog("got OK from stdinWorker - remaining count: "+pendingWriteCount+"\n");
                break;
            case "ClosedOK":
                stdinOpenState = CLOSED;
                debugLog("Stdin pipe closed\n");
                break;
            default:
                debugLog("got msg from stdinWorker: "+event.data+"\n");
            }
        };
        stdinWorker.onerror = function(error) {
            pendingWriteCount--;
            exitCode = -2;
            LogError("got error from stdinWorker: "+error.message+"\n");
        };

        stdinWorker.postMessage({msg: "init", libc: options.libc});
    }

    /*
     * writeStdin()
     * @data: String containing the data to write
     *
     * Write data to the subprocess' stdin (equals to sending a request to the
     * ChromeWorker object to write the data).
     */
    function writeStdin(data) {
        ++pendingWriteCount;
        debugLog("sending "+data.length+" bytes to stdinWorker\n");
        var pipePtr = parseInt(ctypes.cast(child.stdin.address(), ctypes.uintptr_t).value);

        stdinWorker.postMessage({
                msg: 'write',
                pipe: pipePtr,
                data: data
            });
    }

    /*
     * closeStdinHandle()
     *
     * Close the stdin pipe, either directly or by requesting the ChromeWorker to
     * close the pipe. The ChromeWorker will only close the pipe after the last write
     * request process is done.
     */

    function closeStdinHandle() {
        debugLog("trying to close stdin\n");
        if (stdinOpenState != OPEN) return;
        stdinOpenState = CLOSEABLE;

        if (stdinWorker) {
            debugLog("sending close stdin to worker\n");
            var pipePtr = parseInt(ctypes.cast(child.stdin.address(), ctypes.uintptr_t).value);
            stdinWorker.postMessage({
                msg: 'close',
                pipe: pipePtr
            });
        }
        else {
            stdinOpenState = CLOSED;
            debugLog("Closing Stdin\n");
            CloseHandle(child.stdin) || LogError("CloseHandle hInputWrite failed");
        }
    }


    /*
     * createReader(pipe, name)
     *
     * @pipe: handle to the pipe
     * @name: String containing the pipe name (stdout or stderr)
     *
     * Create a ChromeWorker object for reading data asynchronously from
     * the pipe (i.e. on a separate thread), and passing the result back to
     * the caller.
     */
    function createReader(pipe, name, callbackFunc) {
        var worker = new ChromeWorker("subprocess_worker_win.js");
        worker.onmessage = function(event) {
            switch(event.data.msg) {
            case "data":
                debugLog("got "+event.data.count+" bytes from "+name+"\n");
                var data = '';
                if (options.charset === null) {
                    data = event.data.data;
                }
                else
                    data = convertBytes(event.data.data, options.charset);

                callbackFunc(data);
                break;
            case "done":
                debugLog("Pipe "+name+" closed\n");
                --readers;
                if (readers == 0) cleanup();
                break;
            case "error":
                exitCode = -2;
				LogError("Got msg from "+name+": "+event.data.data+"\n");
                break;
            default:
                debugLog("Got msg from "+name+": "+event.data.data+"\n");
            }
        };

        worker.onerror = function(errorMsg) {
            LogError("Got error from windows "+name+": "+errorMsg.message);
            exitCode = -2;
        };

        var pipePtr = parseInt(ctypes.cast(pipe.address(), ctypes.uintptr_t).value);

        worker.postMessage({
                msg: 'read',
                pipe: pipePtr,
                libc: options.libc,
                charset: options.charset === null ? "null" : options.charset,
                bufferedOutput: options.bufferedOutput,
                name: name
            });

        return worker;
    }

    /*
     * readPipes()
     *
     * Open the pipes for reading from stdout and stderr
     */
    function readPipes() {

        stdoutWorker = createReader(child.stdout, "stdout", function (data) {
            if(options.stdout) {
                setTimeout(function() {
                    options.stdout(data);
                }, 0);
            } else {
                output += data;
            }
        });


        stderrWorker = createReader(child.stderr, "stderr", function (data) {
            var output = options.mergeStderr ? 'stdout' : 'stderr';
            if(options[output]) {
                setTimeout(function() {
                    options[output](data);
                }, 0);
            } else {
                error += data;
            }
        });
    }

    /*
     * cleanup()
     *
     * close stdin if needed, get the exit code from the subprocess and invoke
     * the caller's done() function.
     *
     * Note: because stdout() and stderr() are called using setTimeout, we need to
     * do the same here in order to guarantee the message sequence.
     */
    function cleanup() {
        debugLog("Cleanup called\n");
        if(active) {
            active = false;

            closeStdinHandle(); // should only be required in case of errors

            var exit = new DWORD();
            GetExitCodeProcess(child.process, exit.address());

            if (exitCode > -2)
              exitCode = exit.value;

            if (stdinWorker)
                stdinWorker.postMessage({msg: 'stop'});

            setTimeout(function _done() {
                if (options.done) {
                    try {
                        options.done({
                            exitCode: exitCode,
                            stdout: output,
                            stderr: error
                        });
                    }
                    catch (ex) {
                        // prevent from blocking if options.done() throws an error
                        done = true;
                        throw ex;
                    }
                }
                done = true;
            }, 0);
            kernel32dll.close();
        }
    }

    var cmdStr = getCommandStr(options.command);
    var workDir = getWorkDir(options.workdir);

    //main
    hChildProcess = popen(cmdStr, workDir, options.arguments, options.environment, child);

    readPipes();

    if (options.stdin) {
       createStdinWriter();

        if(typeof(options.stdin) == 'function') {
            try {
                options.stdin({
                    write: function(data) {
                        writeStdin(data);
                    },
                    close: function() {
                        closeStdinHandle();
                    }
                });
            }
            catch (ex) {
                // prevent from failing if options.stdin() throws an exception
                closeStdinHandle();
                throw ex;
            }
        } else {
            writeStdin(options.stdin);
            closeStdinHandle();
        }
    }
    else
        closeStdinHandle();

    return {
        kill: function(hardKill) {
            // hardKill is currently ignored on Windows
            var r = !!TerminateProcess(child.process, 255);
            cleanup(-1);
            return r;
        },
        wait: function() {
            // wait for async operations to complete
            var thread = Cc['@mozilla.org/thread-manager;1'].getService(Ci.nsIThreadManager).currentThread;
            while (!done) thread.processNextEvent(true);

            return exitCode;
        }
    };
}


function subprocess_unix(options) {
    // stdin pipe states
    const OPEN = 2;
    const CLOSEABLE = 1;
    const CLOSED = 0;

    var libc = ctypes.open(options.libc),
        active = true,
        done = false,
        exitCode = -1,
        workerExitCode = 0,
        child = {},
        pid = -1,
        stdinWorker = null,
        stdoutWorker = null,
        stderrWorker = null,
        pendingWriteCount = 0,
        readers = 2,
        stdinOpenState = OPEN,
        error = '',
        output = '';

    //api declarations

    //pid_t fork(void);
    var fork = libc.declare("fork",
                         ctypes.default_abi,
                         pid_t
    );

    //NULL terminated array of strings, argv[0] will be command >> + 2
    var argv = ctypes.char.ptr.array(options.arguments.length + 2);
    var envp = ctypes.char.ptr.array(options.environment.length + 1);

    // posix_spawn_file_actions_t is a complex struct that may be different on
    // each platform. We do not care about its attributes, we don't need to
    // get access to them, but we do need to allocate the right amount
    // of memory for it.
    // At 2013/10/28, its size was 80 on linux, but better be safe (and larger),
    // than crash when posix_spawn_file_actions_init fill `action` with zeros.
    // Use `gcc sizeof_fileaction.c && ./a.out` to check that size.
    var posix_spawn_file_actions_t = ctypes.uint8_t.array(100);

    //int posix_spawn(pid_t *restrict pid, const char *restrict path,
    //   const posix_spawn_file_actions_t *file_actions,
    //   const posix_spawnattr_t *restrict attrp,
    //   char *const argv[restrict], char *const envp[restrict]);
    var posix_spawn = libc.declare("posix_spawn",
                         ctypes.default_abi,
                         ctypes.int,
                         pid_t.ptr,
                         ctypes.char.ptr,
                         posix_spawn_file_actions_t.ptr,
                         ctypes.voidptr_t,
                         argv,
                         envp
    );

    //int posix_spawn_file_actions_init(posix_spawn_file_actions_t *file_actions);
    var posix_spawn_file_actions_init = libc.declare("posix_spawn_file_actions_init",
                         ctypes.default_abi,
                         ctypes.int,
                         posix_spawn_file_actions_t.ptr
    );

    //int posix_spawn_file_actions_destroy(posix_spawn_file_actions_t *file_actions);
    var posix_spawn_file_actions_destroy = libc.declare("posix_spawn_file_actions_destroy",
                         ctypes.default_abi,
                         ctypes.int,
                         posix_spawn_file_actions_t.ptr
    );

    // int posix_spawn_file_actions_adddup2(posix_spawn_file_actions_t *
    //                                      file_actions, int fildes, int newfildes);
    var posix_spawn_file_actions_adddup2 = libc.declare("posix_spawn_file_actions_adddup2",
                         ctypes.default_abi,
                         ctypes.int,
                         posix_spawn_file_actions_t.ptr,
                         ctypes.int,
                         ctypes.int
    );

    // int posix_spawn_file_actions_addclose(posix_spawn_file_actions_t *
    //                                       file_actions, int fildes);
    var posix_spawn_file_actions_addclose = libc.declare("posix_spawn_file_actions_addclose",
                         ctypes.default_abi,
                         ctypes.int,
                         posix_spawn_file_actions_t.ptr,
                         ctypes.int
    );

    //int pipe(int pipefd[2]);
    var pipefd = ctypes.int.array(2);
    var pipe = libc.declare("pipe",
                         ctypes.default_abi,
                         ctypes.int,
                         pipefd
    );

    //int close(int fd);
    var close = libc.declare("close",
                          ctypes.default_abi,
                          ctypes.int,
                          ctypes.int
    );

    //pid_t waitpid(pid_t pid, int *status, int options);
    var waitpid = libc.declare("waitpid",
                          ctypes.default_abi,
                          pid_t,
                          pid_t,
                          ctypes.int.ptr,
                          ctypes.int
    );

    //int kill(pid_t pid, int sig);
    var kill = libc.declare("kill",
                          ctypes.default_abi,
                          ctypes.int,
                          pid_t,
                          ctypes.int
    );

    //int read(int fd, void *buf, size_t count);
    var bufferSize = 1024;
    var buffer = ctypes.char.array(bufferSize);
    var read = libc.declare("read",
                          ctypes.default_abi,
                          ctypes.int,
                          ctypes.int,
                          buffer,
                          ctypes.int
    );

    //ssize_t write(int fd, const void *buf, size_t count);
    var write = libc.declare("write",
                          ctypes.default_abi,
                          ctypes.int,
                          ctypes.int,
                          ctypes.char.ptr,
                          ctypes.int
    );

    //int chdir(const char *path);
    var chdir = libc.declare("chdir",
                          ctypes.default_abi,
                          ctypes.int,
                          ctypes.char.ptr
    );

    //int fcntl(int fd, int cmd, ... /* arg */ );
    var fcntl = libc.declare("fcntl",
                          ctypes.default_abi,
                          ctypes.int,
                          ctypes.int,
                          ctypes.int,
                          ctypes.int
    );

    function popen(command, workdir, args, environment, child) {
        var _in,
            _out,
            _err,
            pid,
            rc,
            i;
        _in = new pipefd();
        _out = new pipefd();
        _err = new pipefd();

        var _args = argv();
        args.unshift(command);
        for(i=0;i<args.length;i++) {
            _args[i] = ctypes.char.array()(args[i]);
        }
        var _envp = envp();
        for(i=0;i<environment.length;i++) {
            _envp[i] = ctypes.char.array()(environment[i]);
        }

        rc = pipe(_in);
        if (rc < 0) {
            return -1;
        }
        rc = pipe(_out);
        fcntl(_out[0], F_SETFL, getPlatformValue(O_NONBLOCK));
        if (rc < 0) {
            close(_in[0]);
            close(_in[1]);
            return -1;
        }
        rc = pipe(_err);
        fcntl(_err[0], F_SETFL, getPlatformValue(O_NONBLOCK));
        if (rc < 0) {
            close(_in[0]);
            close(_in[1]);
            close(_out[0]);
            close(_out[1]);
            return -1;
        }

        let STDIN_FILENO = 0;
        let STDOUT_FILENO = 1;
        let STDERR_FILENO = 2;

        let action = posix_spawn_file_actions_t();
        posix_spawn_file_actions_init(action.address());

        posix_spawn_file_actions_adddup2(action.address(), _in[0], STDIN_FILENO);
        posix_spawn_file_actions_addclose(action.address(), _in[1]);
        posix_spawn_file_actions_addclose(action.address(), _in[0]);

        posix_spawn_file_actions_adddup2(action.address(), _out[1], STDOUT_FILENO);
        posix_spawn_file_actions_addclose(action.address(), _out[1]);
        posix_spawn_file_actions_addclose(action.address(), _out[0]);

        posix_spawn_file_actions_adddup2(action.address(), _err[1], STDERR_FILENO);
        posix_spawn_file_actions_addclose(action.address(), _err[1]);
        posix_spawn_file_actions_addclose(action.address(), _err[0]);

        // posix_spawn doesn't support setting a custom workdir for the child,
        // so change the cwd in the parent process before launching the child process.
        if (workdir) {
          if (chdir(workdir) < 0) {
            throw new Error("Unable to change workdir before launching child process");
          }
        }

        closeOtherFds(action, _in[1], _out[0], _err[0]);

        let id = pid_t(0);
        let rv = posix_spawn(id.address(), command, action.address(), null, _args, _envp);
        posix_spawn_file_actions_destroy(action.address());
        if (rv != 0) {
          // we should not really end up here
          close(_err[0]);
          close(_err[1]);
          close(_out[0]);
          close(_out[1]);
          close(_in[0]);
          close(_in[1]);
          throw new Error("Fatal - failed to create subprocess '"+command+"'");
        }
        pid = id.value;

        close(_in[0]);
        close(_out[1]);
        close(_err[1]);
        child.stdin  = _in[1];
        child.stdout = _out[0];
        child.stderr = _err[0];
        child.pid = pid;

        return pid;
    }


    // close any file descriptors that are not required for the process
    function closeOtherFds(action, fdIn, fdOut, fdErr) {
        // Unfortunately on mac, any fd registered in posix_spawn_file_actions_addclose
        // that can't be closed correctly will make posix_spawn fail...
        // Even if we ensure registering only still opened fds.
        if (gXulRuntime.OS == "Darwin")
            return;

        var maxFD = 256; // arbitrary max


        var rlim_t = getPlatformValue(RLIM_T);

        const RLIMITS = new ctypes.StructType("RLIMITS", [
            {"rlim_cur": rlim_t},
            {"rlim_max": rlim_t}
        ]);

        try {
            var getrlimit = libc.declare("getrlimit",
                                  ctypes.default_abi,
                                  ctypes.int,
                                  ctypes.int,
                                  RLIMITS.ptr
            );

            var rl = new RLIMITS();
            if (getrlimit(getPlatformValue(RLIMIT_NOFILE), rl.address()) == 0) {
                if (rl.rlim_cur <  Math.pow(2,20)) // ignore too high numbers
                  maxFD = rl.rlim_cur;
            }
            debugLog("getlimit: maxFD="+maxFD+"\n");

        }
        catch(ex) {
            debugLog("getrlimit: no such function on this OS\n");
            debugLog(ex.toString());
        }

        // close any file descriptors
        // fd's 0-2 are already closed
        for (var i = 3; i < maxFD; i++) {
            if (i != fdIn && i != fdOut && i != fdErr && fcntl(i, F_GETFD, -1) >= 0) {
                posix_spawn_file_actions_addclose(action.address(), i);
            }
        }
    }

    /*
     * createStdinWriter ()
     *
     * Create a ChromeWorker object for writing data to the subprocess' stdin
     * pipe. The ChromeWorker object lives on a separate thread; this avoids
     * internal deadlocks.
     */
    function createStdinWriter() {
        debugLog("Creating new stdin worker\n");
        stdinWorker = new ChromeWorker(get_worker_url());
        stdinWorker.onmessage = function(event) {
            switch (event.data.msg) {
            case "info":
                switch(event.data.data) {
                case "WriteOK":
                    pendingWriteCount--;
                    debugLog("got OK from stdinWorker - remaining count: "+pendingWriteCount+"\n");
                    break;
                case "ClosedOK":
                    stdinOpenState = CLOSED;
                    debugLog("Stdin pipe closed\n");
                    break;
                default:
                    debugLog("got msg from stdinWorker: "+event.data.data+"\n");
                }
                break;
            case "debug":
                debugLog("stdinWorker: "+event.data.data+"\n");
                break;
            case "error":
                LogError("got error from stdinWorker: "+event.data.data+"\n");
                pendingWriteCount = 0;
                stdinOpenState = CLOSED;
                exitCode = -2;
            }
        };
        stdinWorker.onerror = function(error) {
            pendingWriteCount = 0;
            exitCode = -2;
            closeStdinHandle();
            LogError("got error from stdinWorker: "+error.message+"\n");
        };
        stdinWorker.postMessage({msg: "init", libc: options.libc});
    }

    /*
     * writeStdin()
     * @data: String containing the data to write
     *
     * Write data to the subprocess' stdin (equals to sending a request to the
     * ChromeWorker object to write the data).
     */
    function writeStdin(data) {
        if (stdinOpenState == CLOSED) return; // do not write to closed pipes

        ++pendingWriteCount;
        debugLog("sending "+data.length+" bytes to stdinWorker\n");
        var pipe = parseInt(child.stdin);

        stdinWorker.postMessage({
            msg: 'write',
            pipe: pipe,
            data: data
        });
    }


    /*
     * closeStdinHandle()
     *
     * Close the stdin pipe, either directly or by requesting the ChromeWorker to
     * close the pipe. The ChromeWorker will only close the pipe after the last write
     * request process is done.
     */

    function closeStdinHandle() {
        debugLog("trying to close stdin\n");
        if (stdinOpenState != OPEN) return;
        stdinOpenState = CLOSEABLE;

        if (stdinWorker) {
            debugLog("sending close stdin to worker\n");
            var pipePtr = parseInt(child.stdin);

            stdinWorker.postMessage({
                msg: 'close',
                pipe: pipePtr
            });
        }
        else {
            stdinOpenState = CLOSED;
            debugLog("Closing Stdin\n");
            close(child.stdin) && LogError("CloseHandle stdin failed");
        }
    }


    /*
     * createReader(pipe, name)
     *
     * @pipe: handle to the pipe
     * @name: String containing the pipe name (stdout or stderr)
     * @callbackFunc: function to be called with the read data
     *
     * Create a ChromeWorker object for reading data asynchronously from
     * the pipe (i.e. on a separate thread), and passing the result back to
     * the caller.
     *
     */
    function createReader(pipe, name, callbackFunc) {
        var worker = new ChromeWorker(get_worker_url());
        worker.onmessage = function(event) {
            switch(event.data.msg) {
            case "data":
                debugLog("got "+event.data.count+" bytes from "+name+"\n");
                var data = '';
                if (options.charset === null) {
                    data = event.data.data;
                }
                else
                    data = convertBytes(event.data.data, options.charset);

                callbackFunc(data);
                break;
            case "done":
                debugLog("Pipe "+name+" closed\n");
                if (event.data.data != 0) workerExitCode = event.data.data;
                --readers;
                if (readers == 0) cleanup();
                break;
            case "error":
                LogError("Got error from "+name+": "+event.data.data);
                exitCode = -2;
                break;
            default:
                debugLog("Got msg from "+name+": "+event.data.data+"\n");
            }
        };
        worker.onerror = function(error) {
            LogError("Got error from unix "+name+": "+error.message);
            exitCode = -2;
        };

        worker.postMessage({
                msg: 'read',
                pipe: pipe,
                pid: pid,
                libc: options.libc,
                charset: options.charset === null ? "null" : options.charset,
                bufferedOutput: options.bufferedOutput,
                name: name
            });

        return worker;
    }

    /*
     * readPipes()
     *
     * Open the pipes for reading from stdout and stderr
     */
    function readPipes() {

        stdoutWorker = createReader(child.stdout, "stdout", function (data) {
            if(options.stdout) {
                setTimeout(function() {
                    options.stdout(data);
                }, 0);
            } else {
                output += data;
            }
        });

        stderrWorker = createReader(child.stderr, "stderr", function (data) {
            var output = options.mergeStderr ? 'stdout' : 'stderr';
            if(options[output]) {
                setTimeout(function() {
                    options[output](data);
                }, 0);
            } else {
                error += data;
            }
        });

    }

    function cleanup() {
        debugLog("Cleanup called\n");
        if(active) {
            active = false;

            closeStdinHandle(); // should only be required in case of errors

            var result, status = ctypes.int();
            result = waitpid(child.pid, status.address(), 0);

            if (exitCode > -2) {
              if (result > 0)
                  exitCode = status.value;
              else
                  if (workerExitCode >= 0)
                      exitCode = workerExitCode;
                  else
                      exitCode = status.value;
            }

            if (stdinWorker)
                stdinWorker.postMessage({msg: 'stop'});

            setTimeout(function _done() {
                if (options.done) {
                    try {
                        options.done({
                            exitCode: exitCode,
                            stdout: output,
                            stderr: error
                        });
                    }
                    catch(ex) {
                        // prevent from blocking if options.done() throws an error
                        done = true;
                        throw ex;
                    }

                }
                done = true;
            }, 0);

            libc.close();
        }
    }

    //main

    var cmdStr = getCommandStr(options.command);
    var workDir = getWorkDir(options.workdir);

    child = {};
    pid = popen(cmdStr, workDir, options.arguments, options.environment, child);

    debugLog("subprocess started; got PID "+pid+"\n");

    readPipes();

    if (options.stdin) {
        createStdinWriter();
        if(typeof(options.stdin) == 'function') {
            try {
                options.stdin({
                    write: function(data) {
                        writeStdin(data);
                    },
                    close: function() {
                        closeStdinHandle();
                    }
                });
            }
            catch(ex) {
                // prevent from failing if options.stdin() throws an exception
                closeStdinHandle();
                throw ex;
            }
        } else {
            writeStdin(options.stdin);
            closeStdinHandle();
        }
    }
    else
        closeStdinHandle();


    return {
        wait: function() {
            // wait for async operations to complete
            var thread = Cc['@mozilla.org/thread-manager;1'].getService(Ci.nsIThreadManager).currentThread;
            while (! done) thread.processNextEvent(true);
            return exitCode;
        },
        kill: function(hardKill) {
            var rv = kill(pid, (hardKill ? 9: 15));
            cleanup(-1);
            return rv;
        }
    };
}

var worker_array = 
[' const BufferSize = 1024;\n \
\n \
var libc = null;\n \
var libcFunc = {};\n \
\n \
\n \
/*\n \
    struct pollfd {\n \
         int    fd;       // file descriptor\n \
         short  events;   // events to look for\n \
         short  revents;  // events returned\n \
     };\n \
*/\n \
\n \
var pollfd = new ctypes.StructType("pollfd",\n \
                        [   {"fd": ctypes.int},\n \
                            {"events": ctypes.short},\n \
                            {"revents": ctypes.short}\n \
                        ]);\n \
\n \
var WriteBuffer = ctypes.uint8_t.array(BufferSize);\n \
var ReadBuffer = ctypes.char.array(BufferSize);\n \
\n \
\n \
const POLLIN     = 0x0001;\n \
const POLLOUT    = 0x0004;\n \
\n \
const POLLERR    = 0x0008;         // some poll error occurred\n \
const POLLHUP    = 0x0010;         // file descriptor was "hung up"\n \
const POLLNVAL   = 0x0020;         // requested events "invalid"\n \
\n \
const WNOHANG    = 0x01;\n \
\n \
const ECHILD = 10;\n \
\n \
const pid_t = ctypes.int32_t;\n \
\n \
const INDEFINITE = -1;\n \
const NOWAIT     = 0;\n \
const WAITTIME   = 200;  // wait time for poll() in ms\n \
\n \
function initLibc(libName) {\n \
    postMessage({msg: "debug", data: "initialising library with "+ libName});\n \
\n \
    libc = ctypes.open(libName);\n \
\n \
    libcFunc.pollFds = pollfd.array(1);\n \
\n \
    // int poll(struct pollfd fds[], nfds_t nfds, int timeout);\n \
    libcFunc.poll = libc.declare("poll",\n \
                                  ctypes.default_abi,\n \
                                  ctypes.int,\n \
                                  libcFunc.pollFds,\n \
                                  ctypes.unsigned_int,\n \
                                  ctypes.int);\n \
\n \
    //ssize_t write(int fd, const void *buf, size_t count);\n \
    // NOTE: buf is declared as array of unsigned int8 instead of char to avoid\n \
    // implicit charset conversion\n \
    libcFunc.write = libc.declare("write",\n \
                                  ctypes.default_abi,\n \
                                  ctypes.int,\n \
                                  ctypes.int,\n \
                                  WriteBuffer,\n \
                                  ctypes.int);\n \
\n \
    //int read(int fd, void *buf, size_t count);\n \
    libcFunc.read = libc.declare("read",\n \
                                  ctypes.default_abi,\n \
                                  ctypes.int,\n \
                                  ctypes.int,\n \
                                  ReadBuffer,\n \
                                  ctypes.int);\n \
\n \
    //int pipe(int pipefd[2]);\n \
    libcFunc.pipefd = ctypes.int.array(2);\n \
\n \
    //int close(int fd);\n \
    libcFunc.close = libc.declare("close",\n \
                                  ctypes.default_abi,\n \
                                  ctypes.int,\n \
                                  ctypes.int);\n \
\n \
    //pid_t waitpid(pid_t pid, int *status, int options);\n \
    libcFunc.waitpid = libc.declare("waitpid",\n \
                                  ctypes.default_abi,\n \
                                  pid_t,\n \
                                  pid_t,\n \
                                  ctypes.int.ptr,\n \
                                  ctypes.int);\n \
}\n \
\n \
function closePipe(pipe) {\n \
    libcFunc.close(pipe);\n \
}\n \
\n \
function writePipe(pipe, data) {\n \
\n \
    postMessage({msg: "debug", data: "trying to write to "+pipe});\n \
\n \
    let numChunks = Math.floor(data.length / BufferSize);\n \
    let pData = new WriteBuffer();\n \
\n \
    for (var chunk = 0; chunk <= numChunks; chunk ++) {\n \
        let numBytes = chunk < numChunks ? BufferSize : data.length - chunk * BufferSize;\n \
        for (var i=0; i < numBytes; i++) {\n \
            pData[i] = data.charCodeAt(chunk * BufferSize + i) % 256;\n \
        }\n \
\n \
        let bytesWritten = libcFunc.write(pipe, pData, numBytes);\n \
        if (bytesWritten != numBytes) {\n \
            closePipe(pipe);\n \
            libc.close();\n \
            postMessage({ msg: "error", data: "error: wrote "+bytesWritten+" instead of "+numBytes+" bytes"});\n \
            close();\n \
        }\n \
    }\n \
    postMessage({msg: "info", data: "wrote "+data.length+" bytes of data"});\n \
}\n \
\n \
\n \
function readString(data, length, charset) {\n \
    var r = "";\n \
    for(var i = 0; i < length; i++) {\n \
        if(data[i] == 0 && charset != "null") // stop on NULL character for non-binary data\n \
           break;\n \
\n \
        r += String.fromCharCode(data[i]);\n \
    }\n \
\n \
    return r;\n \
}\n \
\n \
function readPipe(pipe, charset, pid, bufferedOutput) {\n \
    var p = new libcFunc.pollFds;\n \
    p[0].fd = pipe;\n \
    p[0].events = POLLIN | POLLERR | POLLHUP;\n \
    p[0].revents = 0;\n \
    var pollTimeout = WAITTIME;\n \
    var exitCode = -1;\n \
    var readCount = 0;\n \
    var result, status = ctypes.int();\n \
    result = 0;\n \
\n \
    var dataStr = "";\n \
    var dataObj = {};\n \
\n \
    const i=0;\n \
    while (true) {\n \
        if (result == 0) {\n \
            result = libcFunc.waitpid(pid, status.address(), WNOHANG);\n \
            if (result > 0) {\n \
                pollTimeout = NOWAIT;\n \
                exitCode = parseInt(status.value);\n \
                postMessage({msg: "debug", data: "waitpid signaled subprocess stop, exitcode="+status.value });\n \
            }\n \
            else if (result < 0) {\n \
              postMessage({msg: "debug", data: "waitpid returned with errno="+ctypes.errno });\n \
              if (ctypes.errno == ECHILD) {\n \
                pollTimeout = NOWAIT;\n \
              }\n \
            }\n \
        }\n \
        p[i].revents = 0;\n \
        var r = libcFunc.poll(p, 1, pollTimeout);\n \
        if (pollTimeout == NOWAIT) {\n \
          readCount = 0;\n \
        }\n \
        if (r > 0) {\n \
            if (p[i].revents & POLLIN) {\n \
                // postMessage({msg: "debug", data: "reading next chunk"});\n \
\n \
                readCount = readPolledFd(p[i].fd, charset, dataObj);\n \
                if (! bufferedOutput)\n \
                  postMessage({msg: "data", data: dataObj.value, count: dataObj.value.length});\n \
                else\n \
                  dataStr += dataObj.value;\n \
\n \
                if (readCount == 0) break;\n \
            }\n \
\n \
            if (p[i].revents & POLLHUP) {\n \
                postMessage({msg: "debug", data: "poll returned HUP"});\n \
                break;\n \
            }\n \
            else if (p[i].revents & POLLERR) {\n \
                postMessage({msg: "error", data: "poll returned error"});\n \
                break;\n \
            }\n \
            else if (p[i].revents != POLLIN) {\n \
                postMessage({msg: "error", data: "poll returned "+p[i]});\n \
                break;\n \
            }\n \
        }\n \
        else\n \
            if (pollTimeout == NOWAIT || r < 0) break;\n \
    }\n \
\n \
    // continue reading until the buffer is empty\n \
    while (readCount > 0) {\n \
      readCount = readPolledFd(pipe, charset, dataObj);\n \
      if (! bufferedOutput)\n \
        postMessage({msg: "data", data: dataObj.value, count: dataObj.value.length});\n \
      else\n \
        dataStr += dataObj.value;\n \
\n \
      let r = libcFunc.poll(p, 1, NOWAIT);\n \
    }\n \
\n \
    if (bufferedOutput)\n \
      postMessage({msg: "data", data: dataStr, count: dataStr.length});\n \
\n \
    closePipe(pipe);\n \
    postMessage({msg: "done", data: exitCode });\n \
    libc.close();\n \
    close();\n \
}\n \
\n \
function readPolledFd(pipe, charset, dataObj) {\n \
    var line = new ReadBuffer();\n \
    var r = libcFunc.read(pipe, line, BufferSize);\n \
\n \
    if (r > 0) {\n \
        var c = readString(line, r, charset);\n \
        dataObj.value = c;\n \
    }\n \
    else\n \
       dataObj.value = "";\n \
\n \
    return r;\n \
}\n \
\n \
onmessage = function (event) {\n \
    switch (event.data.msg) {\n \
    case "init":\n \
        initLibc(event.data.libc);\n \
        break;\n \
    case "read":\n \
        initLibc(event.data.libc);\n \
        readPipe(event.data.pipe, event.data.charset, event.data.pid, event.data.bufferedOutput);\n \
        break;\n \
    case "write":\n \
        // data contents:\n \
        //   msg: "write"\n \
        //   data: the data (string) to write\n \
        //   pipe: ptr to pipe\n \
        writePipe(event.data.pipe, event.data.data);\n \
        postMessage({msg: "info", data: "WriteOK"});\n \
        break;\n \
    case "close":\n \
        postMessage({msg: "debug", data: "closing stdin\\n"});\n \
\n \
        closePipe(event.data.pipe);\n \
        postMessage({msg: "info", data: "ClosedOK"});\n \
        break;\n \
    case "stop":\n \
        libc.close(); // do not use libc after this point\n \
        close();\n \
        break;\n \
    default:\n \
        throw("error: Unknown command"+event.data.msg+"\\n");\n \
    }\n \
    return;\n \
};'];

var worker_blob = new Blob(worker_array, {type: 'application/javascript'});

var worker_url = null;
var URL = null;
var get_worker_url = function(){
    if (worker_url == null)
        worker_url = URL.createObjectURL(worker_blob);
    return worker_url;
}
