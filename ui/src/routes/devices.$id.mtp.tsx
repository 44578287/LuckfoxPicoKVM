import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LuGlobe,
  LuLink,
  LuRadioReceiver,
  LuHardDrive,
  LuCheck,
  LuUpload,
  LuRefreshCw,
  LuDownload,
} from "react-icons/lu";
import { PlusCircleIcon, ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import { TrashIcon } from "@heroicons/react/16/solid";
import { useNavigate } from "react-router-dom";

import Card, { GridCard } from "@/components/Card";
import { Button } from "@components/Button";
import LogoLuckfox from "@/assets/logo-luckfox.png";
import { formatters } from "@/utils";
import AutoHeight from "@components/AutoHeight";
import { DEVICE_API } from "@/ui.config";

import { useJsonRpc } from "../hooks/useJsonRpc";
import notifications from "../notifications";
import { isOnDevice } from "../main";
import { cx } from "../cva.config";
import {
  useMountMediaStore,
  useRTCStore,
} from "../hooks/stores";
import { UploadDialog } from "@/components/UploadDialog";
import { sync } from "framer-motion";
import Fieldset from "@/components/Fieldset";


export default function MtpRoute() {
  const navigate = useNavigate();
  {
    /* TODO: Migrate to using URLs instead of the global state. To simplify the refactoring, we'll keep the global state for now. */
  }
  return <Dialog onClose={() => navigate("..")} />;
}

export function Dialog({ onClose }: { onClose: () => void }) {
  const {
    modalView,
    setModalView,
    errorMessage,
    setErrorMessage,
  } = useMountMediaStore();
  const navigate = useNavigate();

  const [incompleteFileName, setIncompleteFileName] = useState<string | null>(null);
  const [send] = useJsonRpc();
 
  const [selectedMode, setSelectedMode] = useState< "mtp_device" | "mtp_sd" >("mtp_device");
  return (
    <AutoHeight>
      <div
        className={cx("mx-auto max-w-4xl px-4 transition-all duration-300 ease-in-out", {
          "max-w-4xl": modalView === "mode",
          "max-w-2xl": 
            modalView === "mtp_device" ||
            modalView === "mtp_sd",
          "max-w-xl":
            modalView === "upload" ||
            modalView === "error",
        })}
      >
        <GridCard cardClassName="relative w-full text-left pointer-events-auto">
          <div className="p-10">
            <div className="flex flex-col items-start justify-start space-y-4 text-left">
              <img
                src={LogoLuckfox}
                alt="KVM Logo"
                className="block h-[24px] dark:hidden"
              />
              <img
                src={LogoLuckfox}
                alt="KVM Logo"
                className="hidden h-[24px] dark:mt-0! dark:block"
              />
              {modalView === "mode" && (
                <MtpModeSelectionView
                  onClose={() => onClose()}
                  selectedMode={selectedMode}
                  setSelectedMode={setSelectedMode}
                />
              )}

              {modalView === "mtp_device" && (
                <DeviceFileView
                  onBack={() => {
                    setModalView("mode");
                  }}
                  onNewImageClick={incompleteFile => {
                    setIncompleteFileName(incompleteFile || null);
                    setModalView("upload");
                  }}
                />
              )}

              {modalView === "mtp_sd" && (
                <SDFileView
                  onBack={() => {
                    setModalView("mode");
                  }}
                  onNewImageClick={incompleteFile => {
                    setIncompleteFileName(incompleteFile || null);
                    setModalView("upload_sd");
                  }}
                />
              )}

              {modalView === "upload" && (
                <UploadFileView
                  onBack={() => setModalView("mtp_device")}
                  onCancelUpload={() => {
                    setModalView("mtp_device");
                    // Implement cancel upload logic here
                  }}
                  incompleteFileName={incompleteFileName || undefined}
                  media="local"
                />
              )}

              {modalView === "upload_sd" && (
                <UploadFileView
                  onBack={() => setModalView("mtp_sd")}
                  onCancelUpload={() => {
                    setModalView("mtp_sd");
                    // Implement cancel upload logic here
                  }}
                  incompleteFileName={incompleteFileName || undefined}
                  media="sd"
                />
              )}
              
              {modalView === "error" && (
                <ErrorView
                  errorMessage={errorMessage}
                  onClose={() => {
                    onClose();
                    setErrorMessage(null);
                  }}
                  onRetry={() => {
                    setModalView("mode");
                    setErrorMessage(null);
                  }}
                />
              )}
            </div>
          </div>
        </GridCard>
      </div>
    </AutoHeight>
  );
}

function MtpModeSelectionView({
  onClose,
  selectedMode,
  setSelectedMode,
}: {
  onClose: () => void;
  selectedMode: "mtp_device" | "mtp_sd";
  setSelectedMode: (mode: "mtp_device" | "mtp_sd") => void;
}) {
  const { setModalView } = useMountMediaStore();

  return (
    <div className="w-full space-y-4">
      <div className="animate-fadeIn space-y-0 opacity-0">
        <h2 className="text-lg leading-tight font-bold dark:text-white">
          Virtual Media Source
        </h2>
        <div className="text-sm leading-snug text-slate-600 dark:text-slate-400">
          Choose how you want to mount your virtual media
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {[
          {
            label: "KVM Storage Manager",
            value: "mtp_device",
            description: "Manage the shared folder located on eMMC",
            icon: LuRadioReceiver,
            tag: null,
            disabled: false,
          },
          {
            label: "KVM MicroSD Manager",
            value: "mtp_sd",
            description: "Manage the shared folder located on MicroSD",
            icon: LuRadioReceiver,
            tag: null,
            disabled: false,
          },
        ].map(({ label, description, value: mode, icon: Icon, tag, disabled }, index) => (
          <div
            key={label}
            className="animate-fadeIn opacity-0"
            style={{
              animationDuration: "0.7s",
              animationDelay: `${25 * (index * 5)}ms`,
            }}
          >
            <Card
              className={cx(
                "w-full min-w-[250px] cursor-pointer bg-white shadow-xs transition-all duration-100 hover:shadow-md dark:bg-slate-800",
                {
                  "ring-2 ring-blue-700": selectedMode === mode,
                  "hover:ring-2 hover:ring-blue-500": selectedMode !== mode && !disabled,
                  "cursor-not-allowed!": disabled,
                },
              )}
            >
              <div
                className="relative z-50 flex flex-col items-start p-4 select-none"
                onClick={() =>
                  disabled ? null : setSelectedMode(mode as "mtp_device" | "mtp_sd")
                }
              >
                <div>
                  <Card>
                    <div className="p-1">
                      <Icon className="h-4 w-4 shrink-0 text-blue-700 dark:text-blue-400" />
                    </div>
                  </Card>
                </div>
                <div className="mt-2 space-y-0">
                  <p className="block pt-1 text-xs text-red-500">
                    {tag ? tag : <>&nbsp;</>}
                  </p>

                  <h3 className="text-sm font-medium dark:text-white">{label}</h3>
                  <p className="text-sm text-gray-700 dark:text-slate-400">
                    {description}
                  </p>
                </div>
                <input
                  type="radio"
                  name="localAuthMode"
                  value={mode}
                  disabled={disabled}
                  checked={selectedMode === mode}
                  className="absolute top-4 right-4 form-radio h-4 w-4 rounded-full text-blue-700"
                />
              </div>
            </Card>
          </div>
        ))}
      </div>
      <div
        className="flex animate-fadeIn justify-end opacity-0"
        style={{
          animationDuration: "0.7s",
          animationDelay: "0.2s",
        }}
      >
        <div className="flex gap-x-2 pt-2">
          <Button size="MD" theme="blank" onClick={onClose} text="Cancel" />
          <Button
            size="MD"
            theme="primary"
            onClick={() => {
              setModalView(selectedMode);
            }}
            text="Continue"
          />
        </div>
      </div>
    </div>
  );
}

function DeviceFileView({
  onBack,
  onNewImageClick,
}: {
  onBack: () => void;
  onNewImageClick: (incompleteFileName?: string) => void;
}) {
  const [onStorageFiles, setOnStorageFiles] = useState<
    {
      name: string;
      size: string;
      createdAt: string;
    }[]
  >([]);

  const [selected, setSelected] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const filesPerPage = 5;

  const [send] = useJsonRpc();

  interface StorageSpace {
    bytesUsed: number;
    bytesFree: number;
  }
  const [storageSpace, setStorageSpace] = useState<StorageSpace | null>(null);

  const percentageUsed = useMemo(() => {
    if (!storageSpace) return 0;
    return Number(
      (
        (storageSpace.bytesUsed / (storageSpace.bytesUsed + storageSpace.bytesFree)) *
        100
      ).toFixed(1),
    );
  }, [storageSpace]);

  const bytesUsed = useMemo(() => {
    if (!storageSpace) return 0;
    return storageSpace.bytesUsed;
  }, [storageSpace]);

  const bytesFree = useMemo(() => {
    if (!storageSpace) return 0;
    return storageSpace.bytesFree;
  }, [storageSpace]);

  const syncStorage = useCallback(() => {
    send("listStorageFiles", {}, res => {
      if ("error" in res) {
        notifications.error(`Error listing storage files: ${res.error}`);
        return;
      }
      const { files } = res.result as StorageFiles;
      const formattedFiles = files.map(file => ({
        name: file.filename,
        size: formatters.bytes(file.size),
        createdAt: formatters.date(new Date(file?.createdAt)),
      }));

      setOnStorageFiles(formattedFiles);
    });

    send("getStorageSpace", {}, res => {
      if ("error" in res) {
        notifications.error(`Error getting storage space: ${res.error}`);
        return;
      }

      const space = res.result as StorageSpace;
      setStorageSpace(space);
    });
  }, [send, setOnStorageFiles, setStorageSpace]);

  useEffect(() => {
    syncStorage();
  }, [syncStorage]);

  interface StorageFiles {
    files: {
      filename: string;
      size: number;
      createdAt: string;
    }[];
  }

  useEffect(() => {
    syncStorage();
  }, [syncStorage]);

  function handleDeleteFile(file: { name: string; size: string; createdAt: string }) {
    console.log("Deleting file:", file);
    send("deleteStorageFile", { filename: file.name }, res => {
      if ("error" in res) {
        notifications.error(`Error deleting file: ${res.error}`);
        return;
      }

      syncStorage();
    });
  }
  
  function handleDownloadFile(file: { name: string }) {
    const downloadUrl = `${DEVICE_API}/storage/download?file=${encodeURIComponent(file.name)}`;
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  const indexOfLastFile = currentPage * filesPerPage;
  const indexOfFirstFile = indexOfLastFile - filesPerPage;
  const currentFiles = onStorageFiles.slice(indexOfFirstFile, indexOfLastFile);
  const totalPages = Math.ceil(onStorageFiles.length / filesPerPage);

  const handlePreviousPage = () => {
    setCurrentPage(prev => Math.max(prev - 1, 1));
  };

  const handleNextPage = () => {
    setCurrentPage(prev => Math.min(prev + 1, totalPages));
  };

  return (
    <div className="w-full space-y-4">
      <ViewHeader
        title="Mount from KVM Storage"
        description="Select an image to mount from the KVM storage"
      />
      <div
        className="w-full animate-fadeIn opacity-0"
        style={{
          animationDuration: "0.7s",
          animationDelay: "0.1s",
        }}
      >
        <Card>
          {onStorageFiles.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-center">
              <div className="space-y-3">
                <div className="space-y-1">
                  <PlusCircleIcon className="mx-auto h-6 w-6 text-blue-700 dark:text-blue-500" />
                  <h3 className="text-sm leading-none font-semibold text-black dark:text-white">
                    No images available
                  </h3>
                  <p className="text-xs leading-none text-slate-700 dark:text-slate-300">
                    Upload an image to start virtual media mounting.
                  </p>
                </div>
                <div>
                  <Button
                    size="SM"
                    theme="primary"
                    text="Upload a new File"
                    onClick={() => onNewImageClick()}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="w-full divide-y divide-slate-800/20 dark:divide-slate-300/20">
              {currentFiles.map((file, index) => ( 
                <PreUploadedImageItem
                  key={index}
                  name={file.name}
                  size={file.size}
                  uploadedAt={file.createdAt}
                  isIncomplete={file.name.endsWith(".incomplete")}
                  isSelected={selected === file.name} 
                  onDownload={() => {
                    const selectedFile = onStorageFiles.find(f => f.name === file.name);
                    if (!selectedFile) return;
                    if (
                      window.confirm(
                        "Are you sure you want to download " + selectedFile.name + "?",
                      )
                    ) {
                      handleDownloadFile(selectedFile);
                    }
                  }}
                  onDelete={() => {
                    const selectedFile = onStorageFiles.find(f => f.name === file.name);
                    if (!selectedFile) return;
                    if (
                      window.confirm(
                        "Are you sure you want to delete " + selectedFile.name + "?",
                      )
                    ) {
                      handleDeleteFile(selectedFile);
                    }
                  }}
                  onContinueUpload={() => onNewImageClick(file.name)}
                /> 
              ))}

              {onStorageFiles.length > filesPerPage && (
                <div className="flex items-center justify-between px-3 py-2">
                  <p className="text-sm text-slate-700 dark:text-slate-300">
                    Showing <span className="font-bold">{indexOfFirstFile + 1}</span> to{" "}
                    <span className="font-bold">
                      {Math.min(indexOfLastFile, onStorageFiles.length)}
                    </span>{" "}
                    of <span className="font-bold">{onStorageFiles.length}</span> results
                  </p>
                  <div className="flex items-center gap-x-2">
                    <Button
                      size="XS"
                      theme="light"
                      text="Previous"
                      onClick={handlePreviousPage}
                      disabled={currentPage === 1}
                    />
                    <Button
                      size="XS"
                      theme="light"
                      text="Next"
                      onClick={handleNextPage}
                      disabled={currentPage === totalPages}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      {onStorageFiles.length > 0 ? (
        <div
          className="flex animate-fadeIn items-end justify-between opacity-0"
          style={{
            animationDuration: "0.7s",
            animationDelay: "0.15s",
          }}
        >
          <div className="flex items-center gap-x-2">
            <Button size="MD" theme="blank" text="Back" onClick={() => onBack()} />
          </div>
        </div>
      ) : (
        <div
          className="flex animate-fadeIn items-end justify-end opacity-0"
          style={{
            animationDuration: "0.7s",
            animationDelay: "0.15s",
          }}
        >
          <div className="flex items-center gap-x-2">
            <Button size="MD" theme="light" text="Back" onClick={() => onBack()} />
          </div>
        </div>
      )}
      <hr className="border-slate-800/20 dark:border-slate-300/20" />
      <div
        className="animate-fadeIn space-y-2 opacity-0"
        style={{
          animationDuration: "0.7s",
          animationDelay: "0.20s",
        }}
      >
        <div className="flex justify-between text-sm">
          <span className="font-medium text-black dark:text-white">
            Available Storage
          </span>
          <span className="text-slate-700 dark:text-slate-300">
            {percentageUsed}% used
          </span>
        </div>
        <div className="h-3.5 w-full overflow-hidden rounded-xs bg-slate-200 dark:bg-slate-700">
          <div
            className="h-full rounded-xs bg-blue-700 transition-all duration-300 ease-in-out dark:bg-blue-500"
            style={{ width: `${percentageUsed}%` }}
          ></div>
        </div>
        <div className="flex justify-between text-sm text-slate-600">
          <span className="text-slate-700 dark:text-slate-300">
            {formatters.bytes(bytesUsed)} used
          </span>
          <span className="text-slate-700 dark:text-slate-300">
            {formatters.bytes(bytesFree)} free
          </span>
        </div>
      </div>

      {onStorageFiles.length > 0 && (
        <div
          className="w-full animate-fadeIn opacity-0"
          style={{
            animationDuration: "0.7s",
            animationDelay: "0.25s",
          }}
        >
          <Button
            size="MD"
            theme="light"
            fullWidth
            text="Upload a new File"
            onClick={() => onNewImageClick()}
          />
        </div>
      )}
    </div>
  );
}

function SDFileView({
  onBack,
  onNewImageClick,
}: {
  onBack: () => void;
  onNewImageClick: (incompleteFileName?: string) => void;
}) {
  const [onStorageFiles, setOnStorageFiles] = useState<
    {
      name: string;
      size: string;
      createdAt: string;
    }[]
  >([]);

  const [sdMountStatus, setSDMountStatus] = useState<"ok" | "none" | "fail" | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const filesPerPage = 5;

  const [send] = useJsonRpc();

  interface StorageSpace {
    bytesUsed: number;
    bytesFree: number;
  }
  const [storageSpace, setStorageSpace] = useState<StorageSpace | null>(null);

  const percentageUsed = useMemo(() => {
    if (!storageSpace) return 0;
    return Number(
      (
        (storageSpace.bytesUsed / (storageSpace.bytesUsed + storageSpace.bytesFree)) *
        100
      ).toFixed(1),
    );
  }, [storageSpace]);

  const bytesUsed = useMemo(() => {
    if (!storageSpace) return 0;
    return storageSpace.bytesUsed;
  }, [storageSpace]);

  const bytesFree = useMemo(() => {
    if (!storageSpace) return 0;
    return storageSpace.bytesFree;
  }, [storageSpace]);

  const syncStorage = useCallback(() => {
    send("getSDMountStatus", {}, res => {
      if ("error" in res) {
        notifications.error(`Failed to check SD card status: ${res.error}`);
        setSDMountStatus(null);
        return;
      }

      const { status } = res.result as { status: "ok" | "none" | "fail" }; 
      setSDMountStatus(status);

      if (status === "none") {
        notifications.error("No SD card detected, please insert an SD card");
        return;
      }

      if (status === "fail") {
        notifications.error("SD card mount failed, please format the SD card");
        return;
      }

      send("listSDStorageFiles", {}, res => {
        if ("error" in res) {
          notifications.error(`Error listing SD storage files: ${res.error}`);
          return;
        }
        const { files } = res.result as StorageFiles;
        const formattedFiles = files.map(file => ({
          name: file.filename,
          size: formatters.bytes(file.size),
          createdAt: formatters.date(new Date(file?.createdAt)),
        }));
        setOnStorageFiles(formattedFiles);
        console.log("SD storage files:", formattedFiles);
      });

      send("getSDStorageSpace", {}, res => {
        if ("error" in res) {
          notifications.error(`Error getting SD storage space: ${res.error}`);
          return;
        }
        const space = res.result as StorageSpace;
        setStorageSpace(space);
      });
    });
  }, [send]);

  useEffect(() => {
    syncStorage();
  }, [syncStorage]);

  interface StorageFiles {
    files: {
      filename: string;
      size: number;
      createdAt: string;
    }[];
  }

  useEffect(() => {
    syncStorage();
  }, [syncStorage]);
  
  function handleSDDeleteFile(file: { name: string; size: string; createdAt: string }) {
    console.log("Deleting file:", file);
    send("deleteSDStorageFile", { filename: file.name }, res => {
      if ("error" in res) {
        notifications.error(`Error deleting file: ${res.error}`);
        return;
      }

      syncStorage();
    });
  }  
  
  function handleSDDownloadFile(file: { name: string }) {
    const downloadUrl = `${DEVICE_API}/storage/sd-download?file=${encodeURIComponent(file.name)}`;
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  const indexOfLastFile = currentPage * filesPerPage;
  const indexOfFirstFile = indexOfLastFile - filesPerPage;
  const currentFiles = onStorageFiles.slice(indexOfFirstFile, indexOfLastFile);
  const totalPages = Math.ceil(onStorageFiles.length / filesPerPage);

  const handlePreviousPage = () => {
    setCurrentPage(prev => Math.max(prev - 1, 1));
  };

  const handleNextPage = () => {
    setCurrentPage(prev => Math.min(prev + 1, totalPages));
  };

  async function handleResetSDStorage() { 
    setLoading(true);
    send("resetSDStorage", {}, res => {
      console.log("Reset SD storage response:", res);
      if ("error" in res) {
        notifications.error(`Failed to reset SD card`);
        setLoading(false); 
        return;
      }
    });
    await new Promise(resolve => setTimeout(resolve, 2000));
    setLoading(false); 
    syncStorage();
  }
 
  async function handleUnmountSDStorage() { 
    setLoading(true);
    send("unmountSDStorage", {}, res => {
      console.log("Unmount SD response:", res);
      if ("error" in res) {
        notifications.error(`Failed to unmount SD card`);
        setLoading(false); 
        return;
      }
    });
    await new Promise(resolve => setTimeout(resolve, 2000));
    setLoading(false); 
    syncStorage();
  }

  async function handleMountSDStorage() { 
    setLoading(true);
    send("mountSDStorage", {}, res => {
      console.log("Mount SD response:", res);
      if ("error" in res) {
        notifications.error(`Failed to mount SD card`);
        setLoading(false); 
        return;
      }
    });
    await new Promise(resolve => setTimeout(resolve, 2000));
    setLoading(false); 
    syncStorage();
  }

  if (sdMountStatus && sdMountStatus !== "ok") {
    return (
      <div className="w-full space-y-4">
        <ViewHeader
          title="Mount from KVM MicroSD Card"
          description="Select an image to mount from the KVM storage"
        />
        <div className="flex items-center justify-center py-8 text-center">
          <div className="space-y-3">
            <ExclamationTriangleIcon className="mx-auto h-6 w-6 text-red-500" />
            <h3 className="text-sm font-semibold leading-none text-black dark:text-white">
              {sdMountStatus === "none"
                ? "No SD card detected"
                : "SD card mount failed"}  
              <Button
                size="XS"
                disabled={loading}
                theme="light"
                LeadingIcon={LuRefreshCw}
                onClick={handleResetSDStorage}
              />
            </h3>
            <p className="text-xs leading-none text-slate-700 dark:text-slate-300">
              {sdMountStatus === "none"
                ? "Please insert an SD card and try again."
                : "Please format the SD card and try again."}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (    
    <div className="w-full space-y-4">
      <ViewHeader
        title="Mount from KVM MicroSD Card"
        description="Select an image to mount from the KVM storage"
      />
      <div
        className="w-full animate-fadeIn opacity-0"
        style={{
          animationDuration: "0.7s",
          animationDelay: "0.1s",
        }}
      >
        <Card>
          {onStorageFiles.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-center">
              <div className="space-y-3">
                <div className="space-y-1">
                  <PlusCircleIcon className="mx-auto h-6 w-6 text-blue-700 dark:text-blue-500" />
                  <h3 className="text-sm font-semibold leading-none text-black dark:text-white">
                    No images available
                  </h3>
                  <p className="text-xs leading-none text-slate-700 dark:text-slate-300">
                    Upload a file.
                  </p>
                </div>
                <div>
                  <Button
                    size="SM"
                    disabled={loading}
                    theme="primary"
                    text="Upload a new File"
                    onClick={() => onNewImageClick()}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="divide-y-slate-800/30 w-full divide-y dark:divide-slate-300/20">
              {currentFiles.map((file, index) => (
                <PreUploadedImageItem
                  key={index}
                  name={file.name}
                  size={file.size}
                  uploadedAt={file.createdAt}
                  isIncomplete={file.name.endsWith(".incomplete")}
                  isSelected={selected === file.name}
                  onDownload={() => {
                    const selectedFile = onStorageFiles.find(f => f.name === file.name);
                    if (!selectedFile) return;
                    if (
                      window.confirm(
                        "Are you sure you want to download " + selectedFile.name + "?",
                      )
                    ) {
                      handleSDDownloadFile(selectedFile);
                    }
                  }}
                  onDelete={() => {
                    const selectedFile = onStorageFiles.find(f => f.name === file.name);
                    if (!selectedFile) return;
                    if (window.confirm("Are you sure you want to delete " + selectedFile.name + "?")) {
                      handleSDDeleteFile(selectedFile);
                    }
                  }}
                  onContinueUpload={() => onNewImageClick(file.name)}
                />
              ))}

              {onStorageFiles.length > filesPerPage && (
                <div className="flex items-center justify-between px-3 py-2">
                  <p className="text-sm text-slate-700 dark:text-slate-300">
                    Showing <span className="font-bold">{indexOfFirstFile + 1}</span> to{" "}
                    <span className="font-bold">
                      {Math.min(indexOfLastFile, onStorageFiles.length)}
                    </span>{" "}
                    of <span className="font-bold">{onStorageFiles.length}</span> results
                  </p>
                  <div className="flex items-center gap-x-2">
                    <Button
                      size="XS"
                      theme="light"
                      text="Previous"
                      onClick={handlePreviousPage}
                      disabled={currentPage === 1}
                    />
                    <Button
                      size="XS"
                      theme="light"
                      text="Next"
                      onClick={handleNextPage}
                      disabled={currentPage === totalPages}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      {onStorageFiles.length > 0 ? (
        <div
          className="flex animate-fadeIn items-end justify-between opacity-0"
          style={{
            animationDuration: "0.7s",
            animationDelay: "0.15s",
          }}
        >
          <div className="flex items-center gap-x-2"> 
            <Button size="MD" theme="blank" text="Back" onClick={() => onBack()} />
            <Button
                size="MD"
                disabled={loading}
                theme="light"
                LeadingIcon={LuRefreshCw}
                onClick={handleResetSDStorage}
            />
          </div>
        </div>
      ) : (
        <div
          className="flex w-full animate-fadeIn items-end justify-end opacity-0"
          style={{
            animationDuration: "0.7s",
            animationDelay: "0.15s",
          }}
        >
          <div className="flex items-center gap-x-2 ml-auto ml-auto">
            <Button size="MD" theme="light" text="Back" onClick={() => onBack()} />
            <Button
                size="MD"
                theme="light"
                LeadingIcon={LuRefreshCw}
                onClick={handleResetSDStorage}
            />
          </div>
        </div>
      )}
      <hr className="border-slate-800/20 dark:border-slate-300/20" />
      <div
        className="animate-fadeIn space-y-2 opacity-0"
        style={{
          animationDuration: "0.7s",
          animationDelay: "0.20s",
        }}
      >
        <div className="flex justify-between text-sm">
          <span className="font-medium text-black dark:text-white">
            Available Storage
          </span>
          <span className="text-slate-700 dark:text-slate-300">
            {percentageUsed}% used
          </span>
        </div>
        <div className="h-3.5 w-full overflow-hidden rounded-sm bg-slate-200 dark:bg-slate-700">
          <div
            className="h-full rounded-sm bg-blue-700 transition-all duration-300 ease-in-out dark:bg-blue-500"
            style={{ width: `${percentageUsed}%` }}
          ></div>
        </div>
        <div className="flex justify-between text-sm text-slate-600">
          <span className="text-slate-700 dark:text-slate-300">
            {formatters.bytes(bytesUsed)} used
          </span>
          <span className="text-slate-700 dark:text-slate-300">
            {formatters.bytes(bytesFree)} free
          </span>
        </div>
      </div>

      {onStorageFiles.length > 0 && (
        <div
          className="w-full animate-fadeIn opacity-0"
          style={{
            animationDuration: "0.7s",
            animationDelay: "0.25s",
          }}
        >
          <Button
            size="MD"
            disabled={loading}
            theme="light"
            fullWidth
            text="Upload a new File"
            onClick={() => onNewImageClick()}
          />
        </div>
      )}
  
      <div
        className="w-full animate-fadeIn opacity-0"
        style={{
          animationDuration: "0.7s",
          animationDelay: "0.25s",
        }}
      >
        <Button
          size="MD"
          disabled={loading}
          theme="light"
          fullWidth
          text="Unmount SD Card"
          onClick={() => handleUnmountSDStorage()}
          className="text-red-500 dark:text-red-400"
        />
      </div>
 
    </div>
  );
}

function UploadFileView({
  onBack,
  onCancelUpload,
  incompleteFileName,
  media,
}: {
  onBack: () => void;
  onCancelUpload: () => void;
  incompleteFileName?: string;
  media?: string;
}) {
  const [uploadState, setUploadState] = useState<"idle" | "uploading" | "success">(
    "idle",
  );
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [uploadedFileSize, setUploadedFileSize] = useState<number | null>(null);
  const [uploadSpeed, setUploadSpeed] = useState<number | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [send] = useJsonRpc();
  const rtcDataChannelRef = useRef<RTCDataChannel | null>(null);

  useEffect(() => {
    const ref = rtcDataChannelRef.current;
    return () => {
      console.log("unmounting");
      if (ref) {
        ref.onopen = null;
        ref.onerror = null;
        ref.onmessage = null;
        ref.onclose = null;
        ref.close();
      }
    };
  }, []);

  function handleWebRTCUpload(
    file: File,
    alreadyUploadedBytes: number,
    dataChannel: string,
  ) {
    const rtcDataChannel = useRTCStore
      .getState()
      .peerConnection?.createDataChannel(dataChannel);

    if (!rtcDataChannel) {
      console.error("Failed to create data channel for file upload");
      notifications.error("Failed to create data channel for file upload");
      setUploadState("idle");
      console.log("Upload state set to 'idle'");

      return;
    }

    rtcDataChannelRef.current = rtcDataChannel;

    const lowWaterMark = 256 * 1024;
    const highWaterMark = 1 * 1024 * 1024;
    rtcDataChannel.bufferedAmountLowThreshold = lowWaterMark;

    let lastUploadedBytes = alreadyUploadedBytes;
    let lastUpdateTime = Date.now();
    const speedHistory: number[] = [];

    rtcDataChannel.onmessage = e => {
      try {
        const { AlreadyUploadedBytes, Size } = JSON.parse(e.data) as {
          AlreadyUploadedBytes: number;
          Size: number;
        };

        const now = Date.now();
        const timeDiff = (now - lastUpdateTime) / 1000; // in seconds
        const bytesDiff = AlreadyUploadedBytes - lastUploadedBytes;

        if (timeDiff > 0) {
          const instantSpeed = bytesDiff / timeDiff; // bytes per second

          // Add to speed history, keeping last 5 readings
          speedHistory.push(instantSpeed);
          if (speedHistory.length > 5) {
            speedHistory.shift();
          }

          // Calculate average speed
          const averageSpeed =
            speedHistory.reduce((a, b) => a + b, 0) / speedHistory.length;

          setUploadSpeed(averageSpeed);
          setUploadProgress((AlreadyUploadedBytes / Size) * 100);
        }

        lastUploadedBytes = AlreadyUploadedBytes;
        lastUpdateTime = now;
      } catch (e) {
        console.error("Error processing RTC Data channel message:", e);
      }
    };

    rtcDataChannel.onopen = () => {
      let pauseSending = false; // Pause sending when the buffered amount is high
      const chunkSize = 4 * 1024; // 4KB chunks

      let offset = alreadyUploadedBytes;
      const sendNextChunk = () => {
        if (offset >= file.size) {
          rtcDataChannel.close();
          setUploadState("success");
          return;
        }

        if (pauseSending) return;

        const chunk = file.slice(offset, offset + chunkSize);
        chunk.arrayBuffer().then(buffer => {
          rtcDataChannel.send(buffer);

          if (rtcDataChannel.bufferedAmount >= highWaterMark) {
            pauseSending = true;
          }

          offset += buffer.byteLength;
          console.log(`Chunk sent: ${offset} / ${file.size} bytes`);
          sendNextChunk();
        });
      };

      sendNextChunk();
      rtcDataChannel.onbufferedamountlow = () => {
        console.log("RTC Data channel buffered amount low");
        pauseSending = false; // Now the data channel is ready to send more data
        sendNextChunk();
      };
    };

    rtcDataChannel.onerror = error => {
      console.error("RTC Data channel error:", error);
      notifications.error(`Upload failed: ${error}`);
      setUploadState("idle");
      console.log("Upload state set to 'idle'");
    };
  }

  async function handleHttpUpload(
    file: File,
    alreadyUploadedBytes: number,
    dataChannel: string,
  ) {
    const uploadUrl = `${DEVICE_API}/storage/upload?uploadId=${dataChannel}`;

    const xhr = new XMLHttpRequest();
    xhr.open("POST", uploadUrl, true);

    let lastUploadedBytes = alreadyUploadedBytes;
    let lastUpdateTime = Date.now();
    const speedHistory: number[] = [];

    xhr.upload.onprogress = event => {
      if (event.lengthComputable) {
        const totalUploaded = alreadyUploadedBytes + event.loaded;
        const totalSize = file.size;

        const now = Date.now();
        const timeDiff = (now - lastUpdateTime) / 1000; // in seconds
        const bytesDiff = totalUploaded - lastUploadedBytes;

        if (timeDiff > 0) {
          const instantSpeed = bytesDiff / timeDiff; // bytes per second

          // Add to speed history, keeping last 5 readings
          speedHistory.push(instantSpeed);
          if (speedHistory.length > 5) {
            speedHistory.shift();
          }

          // Calculate average speed
          const averageSpeed =
            speedHistory.reduce((a, b) => a + b, 0) / speedHistory.length;

          setUploadSpeed(averageSpeed);
          setUploadProgress((totalUploaded / totalSize) * 100);
        }

        lastUploadedBytes = totalUploaded;
        lastUpdateTime = now;
      }
    };

    xhr.onload = () => {
      if (xhr.status === 200) {
        setUploadState("success");
      } else {
        console.error("Upload error:", xhr.statusText);
        setUploadError(xhr.statusText);
        setUploadState("idle");
      }
    };

    xhr.onerror = () => {
      console.error("XHR error:", xhr.statusText);
      setUploadError(xhr.statusText);
      setUploadState("idle");
    };

    // Prepare the data to send
    const blob = file.slice(alreadyUploadedBytes);

    // Send the file data
    xhr.send(blob);
  }

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      // Reset the upload error when a new file is selected
      setUploadError(null);

      if (
        incompleteFileName &&
        file.name !== incompleteFileName.replace(".incomplete", "")
      ) {
        setFileError(
          `Please select the file "${incompleteFileName.replace(".incomplete", "")}" to continue the upload.`,
        );
        return;
      }

      setFileError(null);
      console.log(`File selected: ${file.name}, size: ${file.size} bytes`);
      setUploadedFileName(file.name);
      setUploadedFileSize(file.size);
      setUploadState("uploading");
      console.log("Upload state set to 'uploading'");

      if ( media === "sd" ) {
        send("startSDStorageFileUpload", { filename: file.name, size: file.size }, resp => {
          console.log("startSDStorageFileUpload response:", resp);
          if ("error" in resp) {
            console.error("Upload error:", resp.error.message);
            setUploadError(resp.error.data || resp.error.message);
            setUploadState("idle");
            console.log("Upload state set to 'idle'");
            return;
          }

          const { alreadyUploadedBytes, dataChannel } = resp.result as {
            alreadyUploadedBytes: number;
            dataChannel: string;
          };

          console.log(
            `Already uploaded bytes: ${alreadyUploadedBytes}, Data channel: ${dataChannel}`,
          );

          if (isOnDevice) {
            handleHttpUpload(file, alreadyUploadedBytes, dataChannel);
          } else {
            handleWebRTCUpload(file, alreadyUploadedBytes, dataChannel);
          }
        });
      }
      else {
        send("startStorageFileUpload", { filename: file.name, size: file.size }, resp => {
          console.log("startStorageFileUpload response:", resp);
          if ("error" in resp) {
            console.error("Upload error:", resp.error.message);
            setUploadError(resp.error.data || resp.error.message);
            setUploadState("idle");
            console.log("Upload state set to 'idle'");
            return;
          }

          const { alreadyUploadedBytes, dataChannel } = resp.result as {
            alreadyUploadedBytes: number;
            dataChannel: string;
          };

          console.log(
            `Already uploaded bytes: ${alreadyUploadedBytes}, Data channel: ${dataChannel}`,
          );

          if (isOnDevice) {
            handleHttpUpload(file, alreadyUploadedBytes, dataChannel);
          } else {
            handleWebRTCUpload(file, alreadyUploadedBytes, dataChannel);
          }
        });        
      }
    }
  };
  
  return (
    <div className="w-full space-y-4">
      <UploadDialog
        open={true}
        title="Upload New Image"
        description={
          incompleteFileName
            ? `Continue uploading "${incompleteFileName}"`
            : "Select an image file to upload to KVM storage"
        }
      >
        <div
          className="animate-fadeIn space-y-2 opacity-0"
          style={{
            animationDuration: "0.7s",
          }}
        >
          <div
            onClick={() => {
              if (uploadState === "idle") {
                document.getElementById("file-upload")?.click();
              }
            }}
            className="block select-none"
          >
            <div className="group">
              <Card
                className={cx("transition-all duration-300", {
                  "cursor-pointer hover:bg-blue-50/50 dark:hover:bg-blue-900/50":
                    uploadState === "idle",
                })}
              >
                <div className="h-[186px] w-full px-4">
                  <div className="flex h-full flex-col items-center justify-center text-center">
                    {uploadState === "idle" && (
                      <div className="space-y-1">
                        <div className="inline-block">
                          <Card>
                            <div className="p-1">
                              <PlusCircleIcon className="h-4 w-4 shrink-0 text-blue-500 dark:text-blue-400" />
                            </div>
                          </Card>
                        </div>
                        <h3 className="text-sm leading-none font-semibold text-black dark:text-white">
                          {incompleteFileName
                            ? `Click to select "${incompleteFileName.replace(".incomplete", "")}"`
                            : "Click to select a file"}
                        </h3>
                        <p className="text-xs leading-none text-slate-700 dark:text-slate-300">
                          Do not support directory
                        </p>
                      </div>
                    )}

                    {uploadState === "uploading" && (
                      <div className="w-full max-w-sm space-y-2 text-left">
                        <div className="inline-block">
                          <Card>
                            <div className="p-1">
                              <LuUpload className="h-4 w-4 shrink-0 text-blue-500 dark:text-blue-400" />
                            </div>
                          </Card>
                        </div>
                        <h3 className="leading-non text-lg font-semibold text-black dark:text-white">
                          Uploading {formatters.truncateMiddle(uploadedFileName, 30)}
                        </h3>
                        <p className="text-xs leading-none text-slate-700 dark:text-slate-300">
                          {formatters.bytes(uploadedFileSize || 0)}
                        </p>
                        <div className="w-full space-y-2">
                          <div className="h-3.5 w-full overflow-hidden rounded-full bg-slate-300 dark:bg-slate-700">
                            <div
                              className="h-3.5 rounded-full bg-blue-700 transition-all duration-500 ease-linear dark:bg-blue-500"
                              style={{ width: `${uploadProgress}%` }}
                            ></div>
                          </div>
                          <div className="flex justify-between text-xs text-slate-600 dark:text-slate-400">
                            <span>Uploading...</span>
                            <span>
                              {uploadSpeed !== null
                                ? `${formatters.bytes(uploadSpeed)}/s`
                                : "Calculating..."}
                            </span>
                          </div>
                        </div>
                      </div>
                    )}

                    {uploadState === "success" && (
                      <div className="space-y-1">
                        <div className="inline-block">
                          <Card>
                            <div className="p-1">
                              <LuCheck className="h-4 w-4 shrink-0 text-blue-500 dark:text-blue-400" />
                            </div>
                          </Card>
                        </div>
                        <h3 className="text-sm leading-none font-semibold text-black dark:text-white">
                          Upload successful
                        </h3>
                        <p className="text-xs leading-none text-slate-700 dark:text-slate-300">
                          {formatters.truncateMiddle(uploadedFileName, 40)} has been
                          uploaded
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </Card>
            </div>
          </div>
          <input
            id="file-upload"
            type="file"
            onChange={handleFileChange}
            className="hidden"
          />
          {fileError && (
            <p className="mt-2 text-sm text-red-600 dark:text-red-400">{fileError}</p>
          )}
        </div>

        {/* Display upload error if present */}
        {uploadError && (
          <div
            className="mt-2 animate-fadeIn truncate text-sm text-red-600 dark:text-red-400 opacity-0"
            style={{ animationDuration: "0.7s" }}
          >
            Error: {uploadError}
          </div>
        )}

        <div
          className="flex w-full animate-fadeIn items-end opacity-0"
          style={{
            animationDuration: "0.7s",
            animationDelay: "0.1s",
          }}
        >
          <div className="flex w-full justify-end space-x-2">
            {uploadState === "uploading" ? (
              <Button
                size="MD"
                theme="light"
                text="Cancel Upload"
                onClick={() => {
                  onCancelUpload();
                  setUploadState("idle");
                  setUploadProgress(0);
                  setUploadedFileName(null);
                  setUploadedFileSize(null);
                  setUploadSpeed(null);
                }}
              />
            ) : (
              <Button
                size="MD"
                theme={uploadState === "success" ? "primary" : "light"}
                text="Back to Overview"
                onClick={onBack}
              />
            )}
          </div>
        </div>
      </UploadDialog>
    </div>
  );
}

function ErrorView({
  errorMessage,
  onClose,
  onRetry,
}: {
  errorMessage: string | null;
  onClose: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="w-full space-y-4">
      <div className="space-y-2">
        <div className="flex items-center space-x-2 text-red-600">
          <ExclamationTriangleIcon className="h-6 w-6" />
          <h2 className="text-lg leading-tight font-bold">Mount Error</h2>
        </div>
        <p className="text-sm leading-snug text-slate-600">
          An error occurred while attempting to mount the media. Please try again.
        </p>
      </div>
      {errorMessage && (
        <Card className="border border-red-200 bg-red-50 p-4">
          <p className="text-sm font-medium text-red-800">{errorMessage}</p>
        </Card>
      )}
      <div className="flex justify-end space-x-2">
        <Button size="SM" theme="light" text="Close" onClick={onClose} />
        <Button size="SM" theme="primary" text="Back to Overview" onClick={onRetry} />
      </div>
    </div>
  );
}

function PreUploadedImageItem({
  name,
  size,
  uploadedAt,
  isSelected,
  isIncomplete,
  onDownload,
  onDelete,
  onContinueUpload,
}: {
  name: string;
  size: string;
  uploadedAt: string;
  isSelected: boolean;
  isIncomplete: boolean;
  onDownload: () => void;
  onDelete: () => void;
  onContinueUpload: () => void;
}) {
  const [isHovering, setIsHovering] = useState(false);
  return (
    <label
      htmlFor={name}
      className={cx(
        "flex w-full cursor-pointer items-center justify-between p-3 transition-colors",
        {
          "bg-blue-50 dark:bg-blue-900/20": isSelected,
          "hover:bg-gray-50 dark:hover:bg-slate-700/50": !isSelected,
          "cursor-default": isIncomplete,
        },
      )}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      <div className="flex items-center gap-x-4">
        <div className="space-y-0.5 select-none">
          <div className="text-sm leading-none font-semibold dark:text-white">
            {formatters.truncateMiddle(name, 45)}
          </div>
          <div className="flex items-center text-sm">
            <div className="flex items-center gap-x-1 text-slate-600 dark:text-slate-400">
              {formatters.date(new Date(uploadedAt), { month: "short" })}
            </div>
            <div className="mx-1 h-[10px] w-px bg-slate-300 text-slate-300 dark:bg-slate-600"></div>
            <div className="text-gray-600 dark:text-slate-400">{size}</div>
          </div>
        </div>
      </div>
      <div className="relative flex items-center gap-x-3 select-none">
        <div
          className={cx("opacity-0 transition-opacity duration-200", {
            "w-auto opacity-100": isHovering,
          })}
        >
          <Button
            size="XS"
            theme="light"
            LeadingIcon={LuDownload}
            text="Download"
            onClick={e => {
              e.stopPropagation();
              onDownload();
            }}
            className="text-blue-500 dark:text-blue-400"
          />
        </div>
        <div
          className={cx("opacity-0 transition-opacity duration-200", {
            "w-auto opacity-100": isHovering,
          })}
        >
          <Button
            size="XS"
            theme="light"
            LeadingIcon={TrashIcon}
            text="Delete"
            onClick={e => {
              e.stopPropagation();
              onDelete();
            }}
            className="text-red-500 dark:text-red-400"
          />
        </div>
        {isIncomplete && (
          <Button
            size="XS"
            theme="light"
            text="Continue uploading"
            onClick={e => {
              e.stopPropagation();
              onContinueUpload();
            }}
          />
        )}
      </div>
    </label>
  );
}

function ViewHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-0">
      <h2 className="text-lg leading-tight font-bold text-black dark:text-white">
        {title}
      </h2>
      <div className="text-sm leading-snug text-slate-600 dark:text-slate-400">
        {description}
      </div>
    </div>
  );
}
