import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';

// 清理旧版本的Base64体积庞大缓存
if (extension_settings.altAvatars) delete extension_settings.altAvatars;
if (extension_settings.avatarCroppedImages) delete extension_settings.avatarCroppedImages;

// 结构迁移：将旧的 avatarClickZoomEnabled 迁移至新的全局控制变量 avatarGalleryEnabled
if (extension_settings.avatarGalleryEnabled === undefined) {
    extension_settings.avatarGalleryEnabled = extension_settings.avatarClickZoomEnabled !== undefined ? extension_settings.avatarClickZoomEnabled : true;
}
delete extension_settings.avatarClickZoomEnabled;

// 初始化新的数据结构
if (!extension_settings.userGalleryImages) extension_settings.userGalleryImages = [];
if (!extension_settings.charGalleryImages) extension_settings.charGalleryImages = {};
if (!extension_settings.avatarThemeBindings) extension_settings.avatarThemeBindings = {};
if (!extension_settings.avatarThemeCrops) extension_settings.avatarThemeCrops = {};

// 结构迁移：适配旧版单图剪裁配置转换为多图独立剪裁配置
if (extension_settings.avatarThemeCrops) {
    for (const theme in extension_settings.avatarThemeCrops) {
        for (const avatarId in extension_settings.avatarThemeCrops[theme]) {
            const val = extension_settings.avatarThemeCrops[theme][avatarId];
            if (typeof val === 'string') {
                const baseImageKey = extension_settings.avatarThemeBindings?.[theme]?.[avatarId] || avatarId;
                extension_settings.avatarThemeCrops[theme][avatarId] = {};
                extension_settings.avatarThemeCrops[theme][avatarId][baseImageKey] = val;
            }
        }
    }
}

function getAvatarIdFromSrc(src) {
    try {
        const urlObj = new URL(src, window.location.origin);
        const fileParam = urlObj.searchParams.get('file') || urlObj.searchParams.get('avatar');
        if (fileParam) return decodeURIComponent(fileParam);
        
        const parts = urlObj.pathname.split('/');
        let filename = parts[parts.length - 1];
        return decodeURIComponent(filename);
    } catch (e) {
        let cleanSrc = src.split('?')[0];
        const parts = cleanSrc.split('/');
        return decodeURIComponent(parts[parts.length - 1]);
    }
}

function isUserAvatar(src) {
    if (!src) return false;
    const cleanSrc = decodeURIComponent(src);
    return cleanSrc.includes('User Avatars') || cleanSrc.includes('user/images') || cleanSrc.includes('User%20Avatars');
}

function getCurrentTheme() {
    const themeSelect = document.getElementById('themes');
    return themeSelect ? themeSelect.value : 'default';
}

function getBinding(theme, avatarId) {
    return extension_settings.avatarThemeBindings?.[theme]?.[avatarId] || null;
}

// 记录当前真正有效的文件名（过滤掉临时 blob 路径）
let lastValidAvatarId = null;
setInterval(() => {
    const previewImg = document.getElementById('avatar_load_preview');
    if (previewImg) {
        const src = previewImg.getAttribute('src');
        if (src && !src.startsWith('blob:') && !src.startsWith('data:')) {
            lastValidAvatarId = getAvatarIdFromSrc(src);
        }
    }
}, 500);

// ======================== 后端文件操作 ========================

async function uploadToBackend(base64Data, prefix = "image") {
    const b64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
    // 生成6位随机字符以替代顺序数字，避免文件调乱
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const filename = `${prefix}_${randomSuffix}`;
    
    const requestBody = {
        image: b64,
        format: 'png',
        ch_name: '', // 保存至默认的 user/images 实体文件夹中
        filename: filename
    };
    
    try {
        const response = await fetch('/api/images/upload', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(requestBody)
        });
        if (response.ok) {
            const data = await response.json();
            return data.path; 
        }
    } catch(e) {
        console.error('Upload to backend failed', e);
    }
    return null;
}

async function uploadToBackendExact(base64Data, exactFilename) {
    const b64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const requestBody = {
        image: b64,
        format: 'png',
        ch_name: '', 
        filename: exactFilename
    };
    try {
        const response = await fetch('/api/images/upload', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(requestBody)
        });
        if (response.ok) {
            const data = await response.json();
            return data.path; 
        }
    } catch(e) {
        console.error('Upload exact crop to backend failed', e);
    }
    return null;
}

async function deleteFromBackend(path) {
    try {
        // 清理路径中的浏览器缓存时间戳（如有），还原为真实的后端文件路径
        const cleanPath = path.split('?')[0];
        await fetch('/api/images/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ path: cleanPath })
        });
    } catch (e) {
        console.error('Delete from backend failed', e);
    }
}

// 增强版获取 Base64 方法，增加 Canvas 备用方案，解决损坏图像问题
async function getBase64FromUrl(url) {
    if (url.startsWith('data:image')) return url;
    try {
        const data = await fetch(url);
        if (!data.ok) throw new Error('Fetch failed with status ' + data.status);
        const blob = await data.blob();
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(blob); 
        });
    } catch (e) {
        console.warn('[Avatar Gallery] Fetch failed, trying Canvas fallback...', e);
        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = "Anonymous";
            img.onload = () => {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth || img.width;
                    canvas.height = img.naturalHeight || img.height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    resolve(canvas.toDataURL('image/png'));
                } catch (canvasErr) {
                    console.error('[Avatar Gallery] Canvas fallback failed:', canvasErr);
                    resolve(null);
                }
            };
            img.onerror = () => resolve(null);
            img.src = url;
        });
    }
}

async function resizeImageToBase64(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const MAX_SIZE = 800; 
                let width = img.width;
                let height = img.height;
                if (width > height && width > MAX_SIZE) {
                    height *= MAX_SIZE / width;
                    width = MAX_SIZE;
                } else if (height > MAX_SIZE) {
                    width *= MAX_SIZE / height;
                    height = MAX_SIZE;
                }
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', 0.85)); 
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

// ======================== CSS 及插件状态引擎 ========================

function applyAvatarCss() {
    if (!extension_settings.avatarGalleryEnabled) return;
    
    const theme = getCurrentTheme();
    const bindings = extension_settings.avatarThemeBindings?.[theme] || {};
    const crops = extension_settings.avatarThemeCrops?.[theme] || {};
    let cssString = '';
    
    // 整合当前主题下所有需要覆盖的头像ID
    const activeImages = {};
    const allAvatarIds = new Set([...Object.keys(bindings), ...Object.keys(crops)]);

    for (const avatarId of allAvatarIds) {
        if (avatarId === 'thumbnail') continue;
        
        // 获取基准图：若无绑定图，则以本身ID为原图依据
        const baseImageKey = bindings[avatarId] || avatarId;
        let displayPath = baseImageKey;

        // 判断此基准图在当前主题是否拥有独立裁切版本
        if (crops[avatarId] && crops[avatarId][baseImageKey]) {
            displayPath = crops[avatarId][baseImageKey];
        }

        // 如果最终展示的路径与默认原生ID不同，则需要写入CSS
        if (displayPath !== avatarId) {
            activeImages[avatarId] = displayPath;
        }
    }
    
    for (const [avatarId, imagePath] of Object.entries(activeImages)) {
        if (!imagePath) continue;

        const escapedId = avatarId.replace(/"/g, '\\"');
        const encodedId = encodeURIComponent(avatarId).replace(/"/g, '\\"');
        
        cssString += `
            .avatar img[src*="${escapedId}"],
            .avatar img[src*="${encodedId}"],
            #avatar_load_preview[src*="${escapedId}"],
            #avatar_load_preview[src*="${encodedId}"],
            .zoomed_avatar img[src*="${escapedId}"],
            .zoomed_avatar img[src*="${encodedId}"] {
                content: url("${imagePath}") !important;
                object-fit: cover !important;
            }
        `;
    }

    let styleTag = document.getElementById('st-avatar-bindings-style');
    if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'st-avatar-bindings-style';
        document.head.appendChild(styleTag);
    }
    styleTag.textContent = cssString;
}

// ======================== 控制按键注入与更新 ========================

// 注入消息控制栏的专属激活按钮
function injectMessageButton(mesEl) {
    if (!extension_settings.avatarGalleryEnabled) return;
    
    const btnContainer = mesEl.querySelector('.mes_buttons');
    if (!btnContainer) return;
    if (btnContainer.querySelector('.st-mes-avatar-btn')) return;

    const triggerBtn = document.createElement('div');
    // 使用 FontAwesome 的肖像图标
    triggerBtn.className = 'mes_button st-mes-avatar-btn fa-solid fa-image-portrait';
    triggerBtn.title = '头像图库管理';
    
    triggerBtn.onclick = (e) => {
        e.stopPropagation();
        const avatarImg = mesEl.querySelector('.mesAvatarWrapper .avatar img');
        if (avatarImg) {
            // 利用 JS 直接触发原生头像图片点击，避开外层的 pointer-events 拦截
            avatarImg.click();
        } else {
            toastr.warning("未找到头像");
        }
    };

    // 将其置于扩展菜单（...）左侧
    const optionsBtn = btnContainer.querySelector('.extraMesButtonsHint');
    if (optionsBtn) {
        btnContainer.insertBefore(triggerBtn, optionsBtn);
    } else {
        btnContainer.appendChild(triggerBtn);
    }
}

function updatePluginState() {
    const isEnabled = !!extension_settings.avatarGalleryEnabled;
    
    // 清理可能存在的旧版本指针控制 CSS（防止意外干扰）
    const oldPointerStyle = document.getElementById('st-avatar-crop-pointer-events');
    if (oldPointerStyle) oldPointerStyle.remove();

    if (isEnabled) {
        applyAvatarCss();
        document.querySelectorAll('#chat .mes').forEach(injectMessageButton);
    } else {
        // 清理样式
        const styleTag = document.getElementById('st-avatar-bindings-style');
        if (styleTag) styleTag.textContent = '';
        // 移除消息栏按钮
        document.querySelectorAll('.st-mes-avatar-btn').forEach(btn => btn.remove());
    }
}

// ======================== 删除及清理绑定 ========================

async function deleteImages(pathsToDelete, avatarId, isUser) {
    if (isUser) {
        extension_settings.userGalleryImages = extension_settings.userGalleryImages.filter(p => !pathsToDelete.includes(p));
    } else {
        extension_settings.charGalleryImages[avatarId] = extension_settings.charGalleryImages[avatarId].filter(p => !pathsToDelete.includes(p));
    }

    // 清理绑定数据与该图片的依附剪裁图
    if (extension_settings.avatarThemeBindings) {
        for (const theme in extension_settings.avatarThemeBindings) {
            const bindings = extension_settings.avatarThemeBindings[theme];
            if (pathsToDelete.includes(bindings[avatarId])) {
                delete bindings[avatarId];
            }
        }
    }
    if (extension_settings.avatarThemeCrops) {
        for (const theme in extension_settings.avatarThemeCrops) {
            if (extension_settings.avatarThemeCrops[theme][avatarId]) {
                for (const deletedPath of pathsToDelete) {
                    if (extension_settings.avatarThemeCrops[theme][avatarId][deletedPath]) {
                        deleteFromBackend(extension_settings.avatarThemeCrops[theme][avatarId][deletedPath]);
                        delete extension_settings.avatarThemeCrops[theme][avatarId][deletedPath];
                    }
                }
            }
        }
    }

    for (const path of pathsToDelete) {
        await deleteFromBackend(path);
    }

    saveSettingsDebounced();
    applyAvatarCss();
}

// ======================== 图库面板 ========================

async function openGallery(isUser, avatarId, originalSrc, zoomedDiv) {
    if (!extension_settings.userGalleryImages) extension_settings.userGalleryImages = [];
    if (!extension_settings.charGalleryImages) extension_settings.charGalleryImages = {};
    if (!isUser && !extension_settings.charGalleryImages[avatarId]) extension_settings.charGalleryImages[avatarId] = [];
    
    const html = `
        <div id="st-alt-avatar-panel">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid var(--SmartThemeBodyColor, #555); padding-bottom: 10px;">
                <h3 style="margin: 0;">${isUser ? '用户图库' : '角色图库'}</h3>
                <div style="display:flex; gap:10px; align-items:center;">
                    ${!isUser ? `<div class="menu_button menu_button_icon margin0" id="btn-alt-import" title="导入"><i class="fa-solid fa-file-import"></i></div>
                                 <div class="menu_button menu_button_icon margin0" id="btn-alt-export" title="导出"><i class="fa-solid fa-file-export"></i></div>` : ''}
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-upload" title="上传图片"><i class="fa-solid fa-upload"></i></div>
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-manage" title="管理图库"><i class="fa-solid fa-trash-can"></i></div>
                    <div class="menu_button margin0" id="btn-alt-delete-confirm"><i class="fa-solid fa-trash-can"></i> <span>点击删除</span></div>
                </div>
            </div>
            <input type="file" id="input-alt-upload" style="display:none;" accept="image/*" multiple>
            <input type="file" id="input-alt-import" style="display:none;" accept=".json">
            <div class="alt-avatar-grid" id="grid-alt-avatars"></div>
        </div>
    `;

    const currentBinding = getBinding(getCurrentTheme(), avatarId);
    let tempSelectedPath = currentBinding;
    let isDeleteMode = false;
    let itemsToDelete = new Set();
    
    // 去除原文件名可能携带的 13位时间戳前缀
    const avatarNamePrefix = avatarId.split('.')[0].replace(/^\d{13,}-/, '');

    // 提前创建占位事件钩子
    setTimeout(() => {
        const grid = document.getElementById('grid-alt-avatars');
        if(!grid) return;

        const btnUpload = document.getElementById('btn-alt-upload');
        const btnManage = document.getElementById('btn-alt-manage');
        const btnDeleteConfirm = document.getElementById('btn-alt-delete-confirm');
        const btnImport = document.getElementById('btn-alt-import');
        const btnExport = document.getElementById('btn-alt-export');
        const inputUpload = document.getElementById('input-alt-upload');
        const inputImport = document.getElementById('input-alt-import');

        function renderGrid() {
            grid.innerHTML = '';
            
            const origDiv = document.createElement('div');
            origDiv.className = 'alt-avatar-item original-item' + (!tempSelectedPath ? ' selected' : '');
            origDiv.innerHTML = `<img src="${originalSrc}" title="解除绑定 (恢复原图)" onerror="this.src='img/ai4.png'">`;
            origDiv.onclick = () => selectAvatar(null);
            grid.appendChild(origDiv);
            
            const images = isUser ? extension_settings.userGalleryImages : extension_settings.charGalleryImages[avatarId];
            if (images) {
                images.forEach((path) => {
                    const itemDiv = document.createElement('div');
                    itemDiv.className = 'alt-avatar-item' + (tempSelectedPath === path ? ' selected' : '');
                    if (itemsToDelete.has(path)) itemDiv.classList.add('to-delete');
                    
                    itemDiv.innerHTML = `<img src="${path}">`;
                    itemDiv.onclick = (e) => {
                        if (isDeleteMode) { 
                            e.stopPropagation(); 
                            toggleDeleteMark(path, itemDiv);
                        } else { 
                            selectAvatar(path); 
                        }
                    };
                    grid.appendChild(itemDiv);
                });
            }
        }
        
        function selectAvatar(path) {
            if (isDeleteMode) return;
            tempSelectedPath = path;
            renderGrid();
        }

        function toggleDeleteMark(path, element) {
            if (itemsToDelete.has(path)) {
                itemsToDelete.delete(path);
                element.classList.remove('to-delete');
            } else {
                itemsToDelete.add(path);
                element.classList.add('to-delete');
            }
        }
        
        btnManage.onclick = () => {
            isDeleteMode = !isDeleteMode;
            if (isDeleteMode) {
                btnManage.innerHTML = '<i class="fa-solid fa-xmark"></i>';
                btnManage.title = '退出管理';
                btnUpload.style.display = 'none';
                if(btnImport) btnImport.style.display = 'none';
                if(btnExport) btnExport.style.display = 'none';
                btnDeleteConfirm.classList.add('active');
                itemsToDelete.clear();
            } else {
                btnManage.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
                btnManage.title = '管理图库';
                btnUpload.style.display = 'flex';
                if(btnImport) btnImport.style.display = 'flex';
                if(btnExport) btnExport.style.display = 'flex';
                btnDeleteConfirm.classList.remove('active');
                itemsToDelete.clear();
            }
            grid.classList.toggle('delete-mode', isDeleteMode);
            renderGrid();
        };

        btnDeleteConfirm.onclick = async () => {
            if (itemsToDelete.size === 0) return btnManage.click();

            const confirm = await callGenericPopup(`是否确认删除选中的 ${itemsToDelete.size} 张图片？相关绑定将被清空。`, POPUP_TYPE.CONFIRM, '', { okButton: '确认', cancelButton: '取消' });
            if (confirm !== POPUP_RESULT.AFFIRMATIVE) return;

            // 如果删除了当前临时选中的图片，重置临时选择
            if (itemsToDelete.has(tempSelectedPath)) {
                tempSelectedPath = null;
            }

            await deleteImages(Array.from(itemsToDelete), avatarId, isUser);
            btnManage.click(); 
            toastr.success('已删除图片');
        };
        
        btnUpload.onclick = () => inputUpload.click();
        inputUpload.onchange = async (e) => {
            const files = e.target.files;
            if (!files || files.length === 0) return;
            toastr.info(`正在处理 ${files.length} 张图片`);
            
            let count = 0;
            for(let i = 0; i < files.length; i++) {
                const b64 = await resizeImageToBase64(files[i]);
                const path = await uploadToBackend(b64, avatarNamePrefix);
                if (path) {
                    if (isUser) {
                        extension_settings.userGalleryImages.push(path);
                    } else {
                        extension_settings.charGalleryImages[avatarId].push(path);
                    }
                    count++;
                }
            }
            
            saveSettingsDebounced();
            renderGrid();
            inputUpload.value = ''; 
            toastr.success(`已上传 ${count} 张图片`);
        };

        if (btnExport) {
            btnExport.onclick = async () => {
                const images = extension_settings.charGalleryImages[avatarId] || [];
                if (images.length === 0) return toastr.warning('角色图库为空，请先上传图片');
                toastr.info('正在获取图片，请稍候...');
                const exportData = [];
                for (const path of images) {
                    try { exportData.push(await getBase64FromUrl(path)); } catch(e) {}
                }
                const blob = new Blob([JSON.stringify(exportData)], {type: "application/json"});
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `替换卡面-${avatarNamePrefix}.json`;
                a.click();
                URL.revokeObjectURL(url);
                toastr.success('已导出角色图库');
            };
        }

        if (btnImport) {
            btnImport.onclick = () => inputImport.click();
            inputImport.onchange = (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = async (ev) => {
                    try {
                        const data = JSON.parse(ev.target.result);
                        if (!Array.isArray(data)) throw new Error("Format Err");
                        toastr.info(`正在导入 ${data.length} 张图片`);
                        let count = 0;
                        for (const b64 of data) {
                            const path = await uploadToBackend(b64, avatarNamePrefix);
                            if (path) {
                                extension_settings.charGalleryImages[avatarId].push(path);
                                count++;
                            }
                        }
                        saveSettingsDebounced();
                        renderGrid();
                        toastr.success(`已上传 ${count} 张图片`);
                    } catch (err) {
                        toastr.error('导入失败，文件格式不正确');
                    }
                    inputImport.value = '';
                };
                reader.readAsText(file);
            };
        }
        
        renderGrid();
    }, 100);

    const result = await callGenericPopup(html, POPUP_TYPE.CONFIRM, '', { wide: true, large: true, okButton: '选择此图片', cancelButton: '取消' });
    
    // 用户点击了选择此图片按钮才保存修改
    if (result === POPUP_RESULT.AFFIRMATIVE) {
        if (tempSelectedPath !== currentBinding) {
            const theme = getCurrentTheme();
            if (!extension_settings.avatarThemeBindings) extension_settings.avatarThemeBindings = {};
            if (!extension_settings.avatarThemeBindings[theme]) extension_settings.avatarThemeBindings[theme] = {};
            
            if (tempSelectedPath === null) {
                delete extension_settings.avatarThemeBindings[theme][avatarId];
                toastr.success('已恢复原图并解除绑定');
            } else {
                extension_settings.avatarThemeBindings[theme][avatarId] = tempSelectedPath;
                toastr.success('已应用并绑定至当前主题');
            }

            saveSettingsDebounced();
            applyAvatarCss();
            
            // 确认应用后自动关闭外层放大的图片
            const closeBtn = zoomedDiv.querySelector('.dragClose');
            if (closeBtn) closeBtn.click();
        }
    }
}

// ======================== 注入增强控制栏 ========================

async function triggerNativeCropPopup(imgSrc, avatarId, isUser, zoomedDiv) {
    if (avatarId === 'thumbnail') return toastr.error('无法获取图片');

    const theme = getCurrentTheme();
    // 强制使用当前图库选定的原大尺寸图（若无则用原图），保证剪裁的是无损的基准图像
    const baseImageKey = extension_settings.avatarThemeBindings?.[theme]?.[avatarId] || avatarId;
    let sourcePath = extension_settings.avatarThemeBindings?.[theme]?.[avatarId] || imgSrc;

    toastr.info('正在读取图片数据，请稍候...');
    
    let base64Original = await getBase64FromUrl(sourcePath);
    
    // 增加严格的获取拦截以防止唤出破损弹窗
    if (!base64Original) {
        return toastr.error('无法读取图片数据，受跨域或路径影响，请更换图片');
    }

    const cropPromise = callGenericPopup('', POPUP_TYPE.CROP, '', { cropAspect: 0, cropImage: base64Original });

    setTimeout(() => {
        const cropperImg = document.querySelector('#dialogue_popup .cropper-hidden');
        if (cropperImg && cropperImg.cropper) {
            const cropper = cropperImg.cropper;
            cropper.setDragMode('move');
            cropper.options.wheelZoomRatio = 0.05;
        }
    }, 150);

    const croppedImageBase64 = await cropPromise;

    if (croppedImageBase64) {
        // 先去参数、再取文件名、再完整解码还原中文
        let cleanSrc = sourcePath.split('?')[0];
        let filenameWithExt = cleanSrc.split('/').pop();
        let baseImageName = decodeURIComponent(filenameWithExt).replace(/\.[^/.]+$/, "");
        
        // 过滤文件系统中不安全的字符，但允许中文字符和基础符号
        baseImageName = baseImageName.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5\-]/g, '');
        const safeThemeName = theme.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5\-]/g, '');
        const exactFilename = `${baseImageName}_${safeThemeName}_1`;

        if (!extension_settings.avatarThemeCrops) extension_settings.avatarThemeCrops = {};
        if (!extension_settings.avatarThemeCrops[theme]) extension_settings.avatarThemeCrops[theme] = {};
        if (!extension_settings.avatarThemeCrops[theme][avatarId]) extension_settings.avatarThemeCrops[theme][avatarId] = {};

        // 覆盖模式：若该基准图在该主题已有裁切版本，先将其删除
        if (extension_settings.avatarThemeCrops[theme][avatarId][baseImageKey]) {
            await deleteFromBackend(extension_settings.avatarThemeCrops[theme][avatarId][baseImageKey]);
        }

        const path = await uploadToBackendExact(croppedImageBase64, exactFilename);
        if (!path) return toastr.error('无法保存图片');

        // 在保存配置时加入时间戳强制浏览器刷新图片缓存，避免显示旧图
        const cacheBusterPath = `${path}?t=${Date.now()}`;
        
        // 仅将裁切图设为临时覆盖（不进入图库）
        extension_settings.avatarThemeCrops[theme][avatarId][baseImageKey] = cacheBusterPath;
        
        saveSettingsDebounced();
        applyAvatarCss(); 
        toastr.success('已应用并绑定至当前主题');

        const closeBtn = zoomedDiv.querySelector('.dragClose');
        if (closeBtn) closeBtn.click();
    }
}

function injectControlBarButtons(zoomedDiv) {
    if (!extension_settings.avatarGalleryEnabled) return;
    if (zoomedDiv.querySelector('.st-avatar-injected-btns')) return;

    const controlBar = zoomedDiv.querySelector('.panelControlBar');
    if (!controlBar) return;

    // 清理可能导致位置失准的内联大小
    zoomedDiv.style.removeProperty('height');
    zoomedDiv.style.removeProperty('width');

    const btnContainer = document.createElement('div');
    btnContainer.className = 'st-avatar-injected-btns';

    const img = zoomedDiv.querySelector('img');
    if (!img) return;
    const originalSrc = img.src;
    const avatarId = getAvatarIdFromSrc(originalSrc);
    const isUser = isUserAvatar(originalSrc);
    const theme = getCurrentTheme();

    // 1. 剪裁按钮
    const cropBtn = document.createElement('div');
    cropBtn.id = 'st-native-crop-btn';
    cropBtn.className = 'fa-solid fa-crop-simple';
    cropBtn.title = '剪裁头像';
    cropBtn.onclick = async (e) => {
        e.stopPropagation(); 
        await triggerNativeCropPopup(originalSrc, avatarId, isUser, zoomedDiv);
    };

    // 2. 恢复原图(取消裁剪)按钮
    const revertBtn = document.createElement('div');
    revertBtn.id = 'st-revert-crop-btn';
    revertBtn.className = 'fa-solid fa-arrow-rotate-left';
    revertBtn.title = '恢复原图 (取消该图片的剪裁)';
    
    // 检查当前使用的基准图是否有剪裁配置，若有则显示该按钮
    const baseImageKey = extension_settings.avatarThemeBindings?.[theme]?.[avatarId] || avatarId;
    if (extension_settings.avatarThemeCrops?.[theme]?.[avatarId]?.[baseImageKey]) {
        revertBtn.style.display = 'flex';
    } else {
        revertBtn.style.display = 'none';
    }

    revertBtn.onclick = async (e) => {
        e.stopPropagation();
        if (extension_settings.avatarThemeCrops?.[theme]?.[avatarId]?.[baseImageKey]) {
            const cropPath = extension_settings.avatarThemeCrops[theme][avatarId][baseImageKey];
            await deleteFromBackend(cropPath);
            delete extension_settings.avatarThemeCrops[theme][avatarId][baseImageKey];
            saveSettingsDebounced();
            applyAvatarCss();
            toastr.success('已恢复原图');
            revertBtn.style.display = 'none';
            
            const closeBtn = zoomedDiv.querySelector('.dragClose');
            if (closeBtn) closeBtn.click();
        }
    };

    // 3. 图库按钮
    const galleryBtn = document.createElement('div');
    galleryBtn.id = 'st-gallery-btn';
    galleryBtn.className = 'fa-solid fa-images';
    galleryBtn.title = isUser ? '用户图库' : '角色图库';
    galleryBtn.onclick = (e) => {
        e.stopPropagation();
        openGallery(isUser, avatarId, originalSrc, zoomedDiv);
    };

    btnContainer.appendChild(revertBtn);
    btnContainer.appendChild(cropBtn);
    btnContainer.appendChild(galleryBtn);

    const closeBtn = controlBar.querySelector('.dragClose');
    if (closeBtn) controlBar.insertBefore(btnContainer, closeBtn);
    else controlBar.appendChild(btnContainer);
}

// ======================== 初始化监听逻辑 ========================

let lastTheme = getCurrentTheme();

setInterval(() => {
    // 主题切换时重刷 CSS
    const currentTheme = getCurrentTheme();
    if (currentTheme !== lastTheme) {
        lastTheme = currentTheme;
        if (extension_settings.avatarGalleryEnabled) {
            applyAvatarCss(); 
        }
    }

    // 注入设置控制菜单
    try {
        const targetContainer = document.querySelector("#UI-Theme-Block > div.flex-container.flexFlowColumn.flexNoGap > div.flex-container.flexFlowColumn");
        if (targetContainer && !document.getElementById('st-avatar-features-toggle-container')) {
            const container = document.createElement('div');
            container.id = 'st-avatar-features-toggle-container';
            container.className = 'flex-container alignItemsBaseline';
            const isEnabled = !!extension_settings.avatarGalleryEnabled;
            container.innerHTML = `
                <span data-i18n="Avatar Gallery Management">头像图库管理：</span>
                <select id="st-avatar-plugin-select" class="widthNatural flex1 margin0 text_pole" title="启用或关闭整个头像图库及剪裁功能。启用后将会在每条消息旁边添加一键访问图库/剪裁的独立按钮。">
                    <option value="true" ${isEnabled ? 'selected' : ''}>启用</option>
                    <option value="false" ${!isEnabled ? 'selected' : ''}>关闭</option>
                </select>
            `;
            targetContainer.appendChild(container);
            document.getElementById('st-avatar-plugin-select').addEventListener('change', (e) => {
                extension_settings.avatarGalleryEnabled = (e.target.value === 'true');
                saveSettingsDebounced();
                updatePluginState();
            });
        }
    } catch (e) { }
}, 1000);

jQuery(async () => {
    updatePluginState();
    
    // 监听原生上传动作，自动迁移对应的图库及绑定配置，并清理旧原图自身的剪裁残留
    document.body.addEventListener('change', (e) => {
        if (e.target && e.target.tagName === 'INPUT' && e.target.type === 'file') {
            const id = e.target.id;
            if (['add_avatar_button', 'character_replace_file', 'avatar_upload_file', 'group_avatar_button'].includes(id)) {
                let oldAvatarId = lastValidAvatarId;
                const previewImg = document.getElementById('avatar_load_preview') || document.querySelector('#group_avatar_preview .avatar img');
                
                if (previewImg) {
                    const src = previewImg.getAttribute('src');
                    if (src && !src.startsWith('blob:') && !src.startsWith('data:')) {
                        oldAvatarId = getAvatarIdFromSrc(src);
                    }
                }

                if (oldAvatarId && oldAvatarId !== 'thumbnail') {
                    let checkCount = 0;
                    const migrateInterval = setInterval(() => {
                        checkCount++;
                        if (previewImg) {
                            const currentSrc = previewImg.getAttribute('src');
                            if (currentSrc && !currentSrc.startsWith('blob:') && !currentSrc.startsWith('data:')) {
                                const newAvatarId = getAvatarIdFromSrc(currentSrc);
                                if (newAvatarId !== oldAvatarId && newAvatarId !== 'thumbnail') {
                                    // 迁移图库列表
                                    if (extension_settings.charGalleryImages && extension_settings.charGalleryImages[oldAvatarId]) {
                                        extension_settings.charGalleryImages[newAvatarId] = JSON.parse(JSON.stringify(extension_settings.charGalleryImages[oldAvatarId]));
                                        delete extension_settings.charGalleryImages[oldAvatarId];
                                    }
                                    // 迁移图库绑定
                                    if (extension_settings.avatarThemeBindings) {
                                        for (const t in extension_settings.avatarThemeBindings) {
                                            if (extension_settings.avatarThemeBindings[t][oldAvatarId]) {
                                                extension_settings.avatarThemeBindings[t][newAvatarId] = extension_settings.avatarThemeBindings[t][oldAvatarId];
                                                delete extension_settings.avatarThemeBindings[t][oldAvatarId];
                                            }
                                        }
                                    }
                                    // 迁移与清理剪裁数据
                                    if (extension_settings.avatarThemeCrops) {
                                        for (const t in extension_settings.avatarThemeCrops) {
                                            if (extension_settings.avatarThemeCrops[t][oldAvatarId]) {
                                                // 当换了新的原图，旧原图自身对应的剪裁图片必须全部删除
                                                const oldOriginalCropPath = extension_settings.avatarThemeCrops[t][oldAvatarId][oldAvatarId];
                                                if (oldOriginalCropPath) {
                                                    deleteFromBackend(oldOriginalCropPath);
                                                    delete extension_settings.avatarThemeCrops[t][oldAvatarId][oldAvatarId];
                                                }
                                                // 将剩余图库图片的独立剪裁配置转移给新原图ID
                                                extension_settings.avatarThemeCrops[t][newAvatarId] = extension_settings.avatarThemeCrops[t][oldAvatarId];
                                                delete extension_settings.avatarThemeCrops[t][oldAvatarId];
                                            }
                                        }
                                    }
                                    saveSettingsDebounced();
                                    applyAvatarCss();
                                }
                                clearInterval(migrateInterval);
                            }
                        }
                        if (checkCount > 20) clearInterval(migrateInterval);
                    }, 500);
                }
            }
        }
    });

    console.log('[Avatar Gallery & Cropper] Successfully Loaded.');

    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    
                    // 监听剪裁弹窗
                    if (node.classList.contains('zoomed_avatar')) injectControlBarButtons(node);
                    else {
                        const zoomed = node.querySelector('.zoomed_avatar');
                        if (zoomed) injectControlBarButtons(zoomed);
                    }

                    // 监听新的聊天气泡以注入专属控制按钮
                    if (node.classList.contains('mes')) injectMessageButton(node);
                    else {
                        const messages = node.querySelectorAll('.mes');
                        messages.forEach(m => injectMessageButton(m));
                    }

                }
            });
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });
});
