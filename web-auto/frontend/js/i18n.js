export const i18n = {
  zh: {
    // Top Bar
    dashboard: '仪表盘',
    backend_online: '后端在线',
    backend_error: '后端错误',
    backend_offline: '后端离线',
    backend_checking: '后端检查中...',
    toggle_theme: '切换主题',
    
    // Project Page
    new_project: '创建新项目',
    project_name: '项目名称',
    project_type: '项目类型',
    image_project: '图片项目 (Images)',
    video_project: '视频项目 (Video)',
    image_dir: '图片目录',
    video_path: '视频文件路径',
    initial_classes: '初始类别 (支持逗号/换行)',
    save_dir: '输出目录 (选填)',
    create_btn: '创建项目',
    creating: '创建中...',
    project_list: '项目列表',
    total_projects: '共 {count} 个项目',
    no_projects: '暂无项目，创建一个开始吧。',
    open_btn: '打开',
    delete_btn: '删除',
    add_data_btn: '新增数据',
    
    // Project List Detail
    type: '类型',
    total: '总量',
    labeled: '已标注',
    unlabeled: '待标注',
    path: '路径',
    created: '创建日期',
    
    // Modals
    add_data_title: '新增数据',
    add_data_desc: '上传图片到项目目录。同名文件将自动重命名。',
    drop_zone: '拖拽图片到此处 或 点击选择',
    upload_status: '上传状态',
    cancel: '取消',
    save: '保存',
    close: '关闭',
    global_settings: '全局设置',
    sam_api_url: 'sam3-api 地址 (Local)',
    cache_dir: '服务器缓存目录 (Server)',
    language: '语言 (Language)',
    
    // Workspaces
    annotations_summary: '标注统计',
    no_classes: '暂无类别',
    create_class: '+ 新建类别',
    image_list: '图片列表',
    loading_images: '加载图片中...',
    no_images: '未找到图片',
    pure_vision: 'Pure Vision',
    preview_results: 'SAM 预测预览',
    select_all: '全选',
    run_inference: '运行预测',
    inferring: '预测中...',
    submit_to: '提交到 {className}',
    submit_all: '全部提交',
    clear_prompts: '清除提示',
    filter_settings: '过滤设置',
    smart_filter: '智能过滤',
    confidence_threshold: '置信度阈值',
    found_results: '找到 {count} 个可能的匹配结果',
    prompts_cleared: '提示已清除',
    preview_results_desc: '使用工具在图像上绘制提示点或框，结果将在此处显示为预览。',
    
    // Video Workspace
    propagation: '传播设置',
    keyframes: '关键帧',
    frame_range: '传播范围 (前/后/双向)',
    imgsz: '工作比例 (Resize)',
    segment_size: '缓存分段大小',
    propagate: '开始传播',
    propagate_desc: '已标注的帧(关键帧)将在此显示，点击"传播"填补空隙。',
    save_all: '保存全部',
    export_dataset: '导出数据集',
    
    // Toasts
    switch_lang: '已切换到中文',
    project_deleted: '项目已删除',
    save_success: '保存成功',
    delete_failed: '删除失败: {error}'
  },
  en: {
    // Top Bar
    dashboard: 'Dashboard',
    backend_online: 'Backend Online',
    backend_error: 'Backend Error',
    backend_offline: 'Backend Offline',
    backend_checking: 'Health Checking...',
    toggle_theme: 'Toggle Theme',
    
    // Project Page
    new_project: 'Create New Project',
    project_name: 'Project Name',
    project_type: 'Project Type',
    image_project: 'Image Project',
    video_project: 'Video Project',
    image_dir: 'Image Directory',
    video_path: 'Video Path',
    initial_classes: 'Initial Classes (Comma or Newline)',
    save_dir: 'Output Directory (Optional)',
    create_btn: 'Create Project',
    creating: 'Creating...',
    project_list: 'Project List',
    total_projects: '{count} Projects total',
    no_projects: 'No projects found. Create one to start.',
    open_btn: 'Open',
    delete_btn: 'Delete',
    add_data_btn: 'Add Data',
    
    // Project List Detail
    type: 'TYPE',
    total: 'TOTAL',
    labeled: 'LABELED',
    unlabeled: 'UNLABELED',
    path: 'Path',
    created: 'Created',
    
    // Modals
    add_data_title: 'Add Data',
    add_data_desc: 'Upload images to project directory. Filenames will be auto-renamed on collision.',
    drop_zone: 'Drop images here or click to select',
    upload_status: 'Upload Status',
    cancel: 'Cancel',
    save: 'Save',
    close: 'Close',
    global_settings: 'Global Settings',
    sam_api_url: 'sam3-api URL (Local)',
    cache_dir: 'Server Cache Directory',
    language: 'Language',
    
    // Workspaces
    annotations_summary: 'Annotations Summary',
    no_classes: 'No classes defined',
    create_class: '+ Create New Class',
    image_list: 'Image List',
    loading_images: 'Loading images...',
    no_images: 'No images found',
    pure_vision: 'Pure Vision',
    preview_results: 'SAM Preview Results',
    select_all: 'All',
    run_inference: 'RUN INFERENCE',
    inferring: 'INFERRING...',
    submit_to: 'Submit to {className}',
    submit_all: 'Submit All',
    clear_prompts: 'Clear Prompts',
    filter_settings: 'Filter Settings',
    smart_filter: 'Smart Filter',
    confidence_threshold: 'CONFIDENCE THRESHOLD',
    found_results: 'Found {count} possible matching results',
    prompts_cleared: 'Prompts cleared',
    preview_results_desc: 'Use tools to draw prompt points or boxes on the image. Results will appear here as previews.',
    
    // Video Workspace
    propagation: 'Propagation',
    keyframes: 'Keyframes',
    frame_range: 'Range (Fwd/Bwd/Both)',
    imgsz: 'imgsz',
    segment_size: 'segment_size',
    propagate: 'Propagate',
    propagate_desc: 'Annotated frames (keyframes) will appear here. Press "Propagate" to fill the gaps.',
    save_all: 'Save All',
    export_dataset: 'Export Dataset',

    // Toasts
    switch_lang: 'Switched to English',
    project_deleted: 'Project deleted',
    save_success: 'Save successful',
    delete_failed: 'Delete failed: {error}'
  },
  
  t(key, params = {}) {
    const lang = localStorage.getItem('language') || 'zh';
    let text = this[lang][key] || key;
    for (const [pk, pv] of Object.entries(params)) {
      text = text.replace(`{${pk}}`, pv);
    }
    return text;
  }
};
