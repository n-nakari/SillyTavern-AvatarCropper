import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';

// 清理旧版本的Base64体积庞大缓存
if (extension_settings.altAvatars) delete extension_settings.altAvatars;
if (extension_settings.avatarCroppedImages) delete extension_settings.avatarCroppedImages;

// 初始化新的数据结构（指向后端实体文件路径）
if (extension_settings.avatarClickZoomEnabled === undefined) extension_settings.avatarClickZoomEnabled = false;
if (!extension_settings.userGalleryImages) extension_settings.userGalleryImages = [];
if (!extension_settings.charGalleryImages) extension_settings.charGalleryImages = {};
if (!extension_settings.avatarThemeBindings) extension_settings.avatarThemeBindings = {};
if (!extension_settings.avatarThemeCrops) extension_settings.avatarThemeCrops = {};

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

let uploadCounter = 0; // 用于保证四位数字简短且在批量导入时不重复

async function uploadToBackend(base64Data, prefix = "image") {
    uploadCounter = (uploadCounter + 1) % 10000;
    const b64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const suffix = uploadCounter.toString().padStart(4, '0');
    // 去除原名中的时间戳（例如 1745680083698-）以保持文件名简短整洁
    const cleanPrefix = prefix.replace(/^\d+-/, '');
    const filename = `${cleanPrefix}_${suffix}`;
    
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

async function deleteFromBackend(path) {
    try {
        await fetch('/api/images/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ path: path })
        });
    } catch (e) {
        console.error('Delete from backend failed', e);
    }
}

async function getBase64FromUrl(url) {
    if (url.startsWith('data:image')) return url;
    const data = await fetch(url);
    const blob = await data.blob();
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob); 
    });
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

// ======================== CSS 引擎 ========================

function applyAvatarCss() {
    const theme = getCurrentTheme();
    const bindings = extension_settings.avatarThemeBindings?.[theme] || {};
    const crops = extension_settings.avatarThemeCrops?.[theme] || {};
    let cssString = '';
    
    // 合并配置：裁切图片作为临时覆盖项，优先级最高
    const activeImages = { ...bindings, ...crops };
    
    for (const [avatarId, imagePath] of Object.entries(activeImages)) {
        if (!imagePath || avatarId === 'thumbnail') continue;

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

function updateClickZoomState() {
    const isEnabled = !!extension_settings.avatarClickZoomEnabled;
    let pointerStyle = document.getElementById('st-avatar-crop-pointer-events');
    if (isEnabled) {
        if (!pointerStyle) {
            pointerStyle = document.createElement('style');
            pointerStyle.id = 'st-avatar-crop-pointer-events';
            document.head.appendChild(pointerStyle);
        }
        pointerStyle.textContent = `
            #chat .mes .mesAvatarWrapper .avatar, 
            #chat .mes .mesAvatarWrapper .avatar img { pointer-events: auto !important; }
        `;
    } else if (pointerStyle) {
        pointerStyle.remove();
    }
}

// ======================== 删除及清理绑定 ========================

async function deleteImages(pathsToDelete, avatarId, isUser) {
    if (isUser) {
        extension_settings.userGalleryImages = extension_settings.userGalleryImages.filter(p => !pathsToDelete.includes(p));
    } else {
        extension_settings.charGalleryImages[avatarId] = extension_settings.charGalleryImages[avatarId].filter(p => !pathsToDelete.includes(p));
    }

    if (extension_settings.avatarThemeBindings) {
        for (const theme in extension_settings.avatarThemeBindings) {
            const bindings = extension_settings.avatarThemeBindings[theme];
            for (const key in bindings) {
                if (pathsToDelete.includes(bindings[key])) {
                    delete bindings[key];
                    // 如果原图被删了，裁切图也会一同清空
                    if (extension_settings.avatarThemeCrops?.[theme]?.[key]) {
                        deleteFromBackend(extension_settings.avatarThemeCrops[theme][key]);
                        delete extension_settings.avatarThemeCrops[theme][key];
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
    const avatarNamePrefix = avatarId.split('.')[0];

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
                const cleanName = avatarNamePrefix.replace(/^\d+-/, '');
                a.download = `替换卡面-${cleanName}.json`;
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
    
    // 用户点击了选择此图片才保存修改
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

            // 清理当前主题的旧裁切缓存覆盖文件
            if (extension_settings.avatarThemeCrops?.[theme]?.[avatarId]) {
                deleteFromBackend(extension_settings.avatarThemeCrops[theme][avatarId]);
                delete extension_settings.avatarThemeCrops[theme][avatarId];
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
    // 强制使用当前图库选定的原大尺寸图（若无则用原图），从而保证剪裁的是无损的基准图像
    let sourcePath = imgSrc;
    if (extension_settings.avatarThemeBindings?.[theme]?.[avatarId]) {
        sourcePath = extension_settings.avatarThemeBindings[theme][avatarId];
    }

    let base64Original = await getBase64FromUrl(sourcePath);
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
        const path = await uploadToBackend(croppedImageBase64, avatarId.split('.')[0]);
        if (!path) return toastr.error('无法保存图片');

        if (!extension_settings.avatarThemeCrops) extension_settings.avatarThemeCrops = {};
        if (!extension_settings.avatarThemeCrops[theme]) extension_settings.avatarThemeCrops[theme] = {};

        // 如果该主题下该人物已有裁切图，将其从后端删除以节约空间
        if (extension_settings.avatarThemeCrops[theme][avatarId]) {
            deleteFromBackend(extension_settings.avatarThemeCrops[theme][avatarId]);
        }

        // 仅将裁切图设为临时覆盖（不进入图库）
        extension_settings.avatarThemeCrops[theme][avatarId] = path;
        
        saveSettingsDebounced();
        applyAvatarCss(); 
        toastr.success('已应用并绑定至当前主题');

        const closeBtn = zoomedDiv.querySelector('.dragClose');
        if (closeBtn) closeBtn.click();
    }
}

function injectControlBarButtons(zoomedDiv) {
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

    // 1. 剪裁按钮
    const cropBtn = document.createElement('div');
    cropBtn.id = 'st-native-crop-btn';
    cropBtn.className = 'fa-solid fa-crop-simple';
    cropBtn.title = '剪裁头像';
    cropBtn.onclick = async (e) => {
        e.stopPropagation(); 
        await triggerNativeCropPopup(originalSrc, avatarId, isUser, zoomedDiv);
    };

    // 2. 图库按钮
    const galleryBtn = document.createElement('div');
    galleryBtn.id = 'st-gallery-btn';
    galleryBtn.className = 'fa-solid fa-images';
    galleryBtn.title = isUser ? '用户图库' : '角色图库';
    galleryBtn.onclick = (e) => {
        e.stopPropagation();
        openGallery(isUser, avatarId, originalSrc, zoomedDiv);
    };

    btnContainer.appendChild(cropBtn);
    btnContainer.appendChild(galleryBtn);

    const closeBtn = controlBar.querySelector('.dragClose');
    if (closeBtn) controlBar.insertBefore(btnContainer, closeBtn);
    else controlBar.appendChild(btnContainer);
}

// ======================== 初始化监听逻辑 ========================

let lastTheme = getCurrentTheme();

setInterval(() => {
    const currentTheme = getCurrentTheme();
    if (currentTheme !== lastTheme) {
        lastTheme = currentTheme;
        applyAvatarCss(); 
    }

    try {
        const targetContainer = document.querySelector("#UI-Theme-Block > div.flex-container.flexFlowColumn.flexNoGap > div.flex-container.flexFlowColumn");
        if (targetContainer && !document.getElementById('st-avatar-features-toggle-container')) {
            const container = document.createElement('div');
            container.id = 'st-avatar-features-toggle-container';
            container.className = 'flex-container alignItemsBaseline';
            const isEnabled = !!extension_settings.avatarClickZoomEnabled;
            container.innerHTML = `
                <span data-i18n="Avatar Click Zoom">头像点击放大：</span>
                <select id="st-avatar-crop-select" class="widthNatural flex1 margin0 text_pole" title="开启后允许点击聊天界面的头像进行放大">
                    <option value="false" ${!isEnabled ? 'selected' : ''}>默认</option>
                    <option value="true" ${isEnabled ? 'selected' : ''}>启用</option>
                </select>
            `;
            targetContainer.appendChild(container);
            document.getElementById('st-avatar-crop-select').addEventListener('change', (e) => {
                extension_settings.avatarClickZoomEnabled = (e.target.value === 'true');
                saveSettingsDebounced();
                updateClickZoomState();
            });
        }
    } catch (e) { }
}, 1000);

jQuery(async () => {
    applyAvatarCss();
    updateClickZoomState();
    
    // 监听原生上传动作，触发解绑并自动迁移对应的图库配置
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
                    // 原生上传文件一被选中，立即清除旧文件的所有主题绑定与裁剪数据（相当于恢复原图显示）
                    if (extension_settings.avatarThemeBindings) {
                        for (const t in extension_settings.avatarThemeBindings) {
                            delete extension_settings.avatarThemeBindings[t][oldAvatarId];
                        }
                    }
                    if (extension_settings.avatarThemeCrops) {
                        for (const t in extension_settings.avatarThemeCrops) {
                            if (extension_settings.avatarThemeCrops[t][oldAvatarId]) {
                                deleteFromBackend(extension_settings.avatarThemeCrops[t][oldAvatarId]);
                                delete extension_settings.avatarThemeCrops[t][oldAvatarId];
                            }
                        }
                    }
                    saveSettingsDebounced();
                    applyAvatarCss();

                    // 后台轮询等待真实的新文件名分配完成后，只迁移图库的归属
                    let checkCount = 0;
                    const migrateInterval = setInterval(() => {
                        checkCount++;
                        if (previewImg) {
                            const currentSrc = previewImg.getAttribute('src');
                            if (currentSrc && !currentSrc.startsWith('blob:') && !currentSrc.startsWith('data:')) {
                                const newAvatarId = getAvatarIdFromSrc(currentSrc);
                                if (newAvatarId !== oldAvatarId && newAvatarId !== 'thumbnail') {
                                    if (extension_settings.charGalleryImages && extension_settings.charGalleryImages[oldAvatarId]) {
                                        extension_settings.charGalleryImages[newAvatarId] = JSON.parse(JSON.stringify(extension_settings.charGalleryImages[oldAvatarId]));
                                        delete extension_settings.charGalleryImages[oldAvatarId];
                                        saveSettingsDebounced();
                                    }
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
                    if (node.classList.contains('zoomed_avatar')) injectControlBarButtons(node);
                    else {
                        const zoomed = node.querySelector('.zoomed_avatar');
                        if (zoomed) injectControlBarButtons(zoomed);
                    }
                }
            });
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });
});
