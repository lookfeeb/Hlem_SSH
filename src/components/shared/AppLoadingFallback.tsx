type AppLoadingFallbackProps = {
  error?: string;
};

export function AppLoadingFallback({ error }: AppLoadingFallbackProps) {
  return (
    <div className="appLoadingFallback">
      <img className="bootMark" src="./Helm_icon.svg" alt="" aria-hidden="true" />
      <span>{error ?? "正在加载工作区..."}</span>
    </div>
  );
}
