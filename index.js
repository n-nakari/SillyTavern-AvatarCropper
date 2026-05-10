import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

// 初始化全新数据结构 (丢弃旧的base64逻辑)
if (!extension_settings.extAvatarGallery) {
    extension_settings.extAvatarGallery = {
        user: [], // 用户图库 (全局通用)
        chars: {} // 角色图库 { "characterName": [url1, url2] }
    };
}
if (!extension_settings.extThemeBindings) {
    // 绑定数据： { "themeName": { "avatarId": "crop_url" } }
    extension_settings.extThemeBindings = {}; 
}

/** 
 * 获取请求头 (必须调用以通过酒馆的安全校验)
 */
function getRequestHeaders() {
    return {
        'Content-Type': 'application/json',
        'X-CSRF-Token': window['csrf_token']
    };
}

function getCurrentTheme() {
    const themeSelect = document.getElementById('themes');
    return themeSelect ? themeSelect.value : 'default';
}

function getAvatarIdFromSrc(src) {
    try {
        const urlObj = new URL(src, window.location.origin);
        const fileParam = urlObj.searchParams.get('file') || urlObj.searchParams.get('avatar');
        if (fileParam) return decodeURIComponent(fileParam);
        
        const parts = urlObj.pathname.split('/');
        return decodeURIComponent(parts[parts.length - 1]);
    } catch (e) {
        let cleanSrc = src.split('?')[0];
        const parts = cleanSrc.split('/');
        return decodeURIComponent(parts[parts.length - 1]);
    }
}

// 判断当前头像是否是 User (Persona)
function isUserAvatar(src) {
    return src.includes('User%20Avatars') || src.includes('User Avatars');
}

/**
 * 核心功能：将图片上传到酒馆后端实体文件夹中
 * @param {File|Blob} file 
 * @param {string} targetName 用于创建子文件夹的名称
 * @returns {Promise<string>} 返回服务器上的实体文件相对路径 URL
 */
async function uploadToBackendAsFile(file, targetName) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const base64Data = e.target.result.split(',')[1];
                // 过滤掉特殊字符用于文件夹名
                const safeSubFolder = 'ext_avatar_' + targetName.replace(/[^a-zA-Z0-9]/g, '');
                const filename = Date.now().toString();

                const response = await fetch('/api/images/upload', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        image: base64Data,
                        format: 'png',
                        ch_name: safeSubFolder,
                        filename: filename
                    })
                });

                if (response.ok) {
                    const data = await response.json();
                    resolve(data.path); // 返回类似 "user/images/ext_avatar_xxx/12345.png"
                } else {
                    reject('上传失败');
                }
            } catch (err) {
                reject(err);
            }
        };
        reader.readAsDataURL(file);
    });
}

/**
 * 核心功能：模拟原生上传操作，完美合并PNG角色卡数据
 */
async function triggerNativeAvatarReplace(url, isUser) {
    try {
        toastr.info('正在应用新的头像...');
        const response = await fetch(url);
        const blob = await response.blob();
        const file = new File([blob], 'avatar.png', { type: 'image/png' });

        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);

        if (isUser) {
            const input = document.getElementById('avatar_upload_file');
            if (input) {
                input.files = dataTransfer.files;
                $(input).trigger('change');
            }
        } else {
            const input = document.getElementById('character_replace_file');
            if (input) {
                input.files = dataTransfer.files;
                $(input).trigger('change');
            }
        }
    } catch (err) {
        console.error('应用原生头像失败:', err);
        toastr.error('切换头像失败');
    }
}

// ======================== CSS 绑定引擎 ========================

function applyThemeBindings() {
    const theme = getCurrentTheme();
    const bindings = extension_settings.extThemeBindings[theme] || {};
    let cssString = '';
    
    for (const [avatarId, cropUrl] of Object.entries(bindings)) {
        if (!cropUrl) continue;
        const escapedId = avatarId.replace(/"/g, '\\"');
        const encodedId = encodeURIComponent(avatarId).replace(/"/g, '\\"');
        
        // 关键点：只应用到聊天栏 (.mes) 中的头像
        cssString += `
            #chat .mes .avatar img[src*="${escapedId}"],
            #chat .mes .avatar img[src*="${encodedId}"] {
                content: url("${cropUrl}") !important;
                object-fit: cover !important;
            }
        `;
    }

    let styleTag = document.getElementById('custom-avatar-theme-binding-style');
    if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'custom-avatar-theme-binding-style';
        document.head.appendChild(styleTag);
    }
    styleTag.textContent = cssString;
}

// 监听主题切换
let lastTheme = getCurrentTheme();
setInterval(() => {
    const currentTheme = getCurrentTheme();
    if (currentTheme !== lastTheme) {
        lastTheme = currentTheme;
        applyThemeBindings(); 
    }
}, 1000);

// ======================== 图库面板 (Gallery) ========================

async function openGalleryPanel(avatarId, isUser, originalSrc) {
    // 确保数据结构存在
    if (!isUser && !extension_settings.extAvatarGallery.chars[avatarId]) {
        extension_settings.extAvatarGallery.chars[avatarId] = [];
    }
    
    let galleryList = isUser 
        ? extension_settings.extAvatarGallery.user 
        : extension_settings.extAvatarGallery.chars[avatarId];
    
    const html = `
        <div id="st-alt-avatar-panel">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid var(--SmartThemeBodyColor, #555); padding-bottom: 10px;">
                <h3 style="margin: 0;">${isUser ? '用户全局图库' : '角色图库'}</h3>
                <div style="display:flex; gap:10px; align-items:center;">
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-upload" title="上传图片"><i class="fa-solid fa-upload"></i></div>
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-manage" title="管理列表"><i class="fa-solid fa-trash-can"></i></div>
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-delete-confirm" title="确认删除 (0)" style="display:none; color:#ff4444;"><i class="fa-solid fa-trash-can"></i></div>
                </div>
            </div>
            <input type="file" id="input-alt-upload" style="display:none;" accept="image/*" multiple>
            <div class="alt-avatar-grid" id="grid-alt-avatars"></div>
        </div>
    `;

    callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true });
    
    setTimeout(() => {
        const grid = document.getElementById('grid-alt-avatars');
        if(!grid) return;

        const btnUpload = document.getElementById('btn-alt-upload');
        const btnManage = document.getElementById('btn-alt-manage');
        const btnDeleteConfirm = document.getElementById('btn-alt-delete-confirm');
        const inputUpload = document.getElementById('input-alt-upload');
        
        let isDeleteMode = false;
        let itemsToDelete = new Set();
        
        function renderGrid() {
            grid.innerHTML = '';
            
            // 渲染列表
            galleryList.forEach((url, index) => {
                const itemDiv = document.createElement('div');
                itemDiv.className = 'alt-avatar-item';
                if (itemsToDelete.has(index)) itemDiv.classList.add('to-delete');
                
                // 简单的判定当前是否为使用中的图 (通过src匹配)
                if(originalSrc && originalSrc.includes(url)) {
                    itemDiv.classList.add('selected');
                }
                
                itemDiv.innerHTML = `<img src="${url}">`;
                itemDiv.onclick = async (e) => {
                    if (isDeleteMode) { 
                        e.stopPropagation(); 
                        if (itemsToDelete.has(index)) {
                            itemsToDelete.delete(index);
                            itemDiv.classList.remove('to-delete');
                        } else {
                            itemsToDelete.add(index);
                            itemDiv.classList.add('to-delete');
                        }
                        btnDeleteConfirm.title = `确认删除 (${itemsToDelete.size})`;
                    } else { 
                        // 点击更换头像 -> 触发原生更换！
                        document.querySelector('#dialogue_popup .dragClose')?.click(); // 关闭弹窗
                        await triggerNativeAvatarReplace(url, isUser);
                    }
                };
                grid.appendChild(itemDiv);
            });
        }
        
        btnManage.onclick = () => {
            isDeleteMode = !isDeleteMode;
            if (isDeleteMode) {
                btnManage.innerHTML = '<i class="fa-solid fa-xmark"></i>';
                btnManage.title = '退出管理';
                btnUpload.style.display = 'none';
                btnDeleteConfirm.style.display = 'flex';
                itemsToDelete.clear();
                btnDeleteConfirm.title = `确认删除 (0)`;
            } else {
                btnManage.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
                btnManage.title = '管理列表';
                btnUpload.style.display = 'flex';
                btnDeleteConfirm.style.display = 'none';
                itemsToDelete.clear();
            }
            renderGrid();
        };

        btnDeleteConfirm.onclick = async () => {
            if (itemsToDelete.size === 0) return btnManage.click();
            const confirm = await callGenericPopup(`是否确认删除选中的 ${itemsToDelete.size} 张图片？`, POPUP_TYPE.CONFIRM);
            if (!confirm) return;

            const indexes = Array.from(itemsToDelete).sort((a, b) => b - a);
            indexes.forEach((idx) => {
                const urlToRemove = galleryList[idx];
                galleryList.splice(idx, 1);
                
                // 级联清理：删除图片后，清空该图片在所有主题里的绑定数据
                Object.keys(extension_settings.extThemeBindings).forEach(theme => {
                    const bindings = extension_settings.extThemeBindings[theme];
                    Object.keys(bindings).forEach(boundId => {
                        if (bindings[boundId] === urlToRemove) {
                            delete bindings[boundId];
                        }
                    });
                });
            });

            saveSettingsDebounced();
            applyThemeBindings();
            
            // 如果最后一张也被删了，其实不用做什么，只有用户再点击时没有图。
            // 酒馆不会自动失去默认头像，除非触发原生替换
            
            btnManage.click(); 
            toastr.success('已成功删除');
        };
        
        btnUpload.onclick = () => inputUpload.click();
        
        inputUpload.onchange = async (e) => {
            const files = e.target.files;
            if (!files || files.length === 0) return;
            
            toastr.info(`正在上传 ${files.length} 张图片到服务器...`);
            let folderName = isUser ? 'UserGallery' : avatarId;

            for(let i = 0; i < files.length; i++) {
                try {
                    const url = await uploadToBackendAsFile(files[i], folderName);
                    galleryList.unshift(url); // 添加到最前
                } catch (err) {
                    toastr.error(`图片 ${files[i].name} 上传失败`);
                }
            }
            
            saveSettingsDebounced();
            renderGrid();
            inputUpload.value = ''; 
            toastr.success('所有图片上传完成');
        };
        
        renderGrid();
    }, 100);
}

// ======================== 原生剪裁弹窗 ========================

async function triggerNativeCropPopup(imgSrc, avatarId, isUser) {
    // 调出酒馆原生剪裁弹窗
    const cropPromise = callGenericPopup('', POPUP_TYPE.CROP, '', { cropAspect: 0, cropImage: imgSrc });

    setTimeout(() => {
        const cropperImg = document.querySelector('#dialogue_popup .cropper-hidden');
        if (cropperImg && cropperImg.cropper) {
            cropperImg.cropper.setDragMode('move');
            cropperImg.cropper.options.wheelZoomRatio = 0.05;
        }
    }, 150);

    const croppedImageBase64 = await cropPromise;

    if (croppedImageBase64) {
        toastr.info('正在保存剪裁结果...');
        // 将剪裁后的图作为实体文件存入后端，防止base64导致卡顿
        try {
            // 将 base64 转 file
            const res = await fetch(croppedImageBase64);
            const blob = await res.blob();
            const cropFile = new File([blob], 'crop.png', { type: 'image/png' });
            
            const folderName = isUser ? 'UserCrop' : avatarId + '_Crop';
            const cropUrl = await uploadToBackendAsFile(cropFile, folderName);

            // 自动绑定到当前主题
            const theme = getCurrentTheme(); 
            if (!extension_settings.extThemeBindings[theme]) extension_settings.extThemeBindings[theme] = {};
            extension_settings.extThemeBindings[theme][avatarId] = cropUrl;
            
            saveSettingsDebounced();
            applyThemeBindings();
            toastr.success('剪裁已保存，并成功绑定至当前主题');

            // 刷新当前弹窗上的按钮状态
            const bindBtn = document.getElementById('st-bind-btn');
            if (bindBtn) bindBtn.classList.add('is-bound');

        } catch (err) {
            console.error(err);
            toastr.error('剪裁图片保存失败');
        }
    }
}

// ======================== 注入控制栏按钮 ========================

function injectButtons(zoomedDiv) {
    // 如果已经注入过，就跳过
    if (zoomedDiv.querySelector('.st-avatar-ext-btn')) return;

    const controlBar = zoomedDiv.querySelector('.panelControlBar');
    if (!controlBar) return;

    const img = zoomedDiv.querySelector('img');
    if (!img) return;

    const imgSrc = img.src;
    const avatarId = getAvatarIdFromSrc(imgSrc);
    if (!avatarId || avatarId === 'thumbnail') return;
    
    const isUser = isUserAvatar(imgSrc);
    const currentTheme = getCurrentTheme();

    // 1. 图库按钮
    const galleryBtn = document.createElement('div');
    galleryBtn.className = 'st-avatar-ext-btn';
    galleryBtn.innerHTML = '<i class="fa-solid fa-images"></i>';
    galleryBtn.title = isUser ? '用户全局图库' : '角色图库';
    galleryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openGalleryPanel(avatarId, isUser, imgSrc);
    });

    // 2. 剪裁按钮
    const cropBtn = document.createElement('div');
    cropBtn.className = 'st-avatar-ext-btn';
    cropBtn.innerHTML = '<i class="fa-solid fa-crop-simple"></i>';
    cropBtn.title = '剪裁聊天栏头像';
    cropBtn.addEventListener('click', async (e) => {
        e.stopPropagation(); 
        zoomedDiv.click(); // 关掉目前的放大图片
        await triggerNativeCropPopup(imgSrc, avatarId, isUser);
    });

    // 3. 绑定按钮
    const bindBtn = document.createElement('div');
    bindBtn.id = 'st-bind-btn';
    bindBtn.className = 'st-avatar-ext-btn';
    bindBtn.innerHTML = '<i class="fa-solid fa-link"></i>';
    bindBtn.title = '绑定当前剪裁头像到此主题';
    
    // 初始化时判断是否处于绑定状态
    const themeBindings = extension_settings.extThemeBindings[currentTheme] || {};
    if (themeBindings[avatarId]) {
        bindBtn.classList.add('is-bound');
    }

    bindBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!extension_settings.extThemeBindings[currentTheme]) {
            extension_settings.extThemeBindings[currentTheme] = {};
        }

        if (bindBtn.classList.contains('is-bound')) {
            // 解除绑定
            delete extension_settings.extThemeBindings[currentTheme][avatarId];
            bindBtn.classList.remove('is-bound');
            toastr.info('已解除绑定，恢复默认头像');
        } else {
            // 尝试绑定：必须存在已有的裁切图，否则提示先去裁切
            // 因为我们要绑定的是"裁剪后的头像"，如果没有，就没法绑。
            // 我们可以在这里检测：如果当前没有已绑定的，我们无法无中生有。必须点击剪裁。
            toastr.warning('请先点击剪裁按钮，剪裁完成后将自动绑定。');
            return;
        }
        
        saveSettingsDebounced();
        applyThemeBindings();
    });

    // 插入按钮到 DOM（在关闭按钮之前）
    const closeBtn = controlBar.querySelector('.dragClose');
    const fragment = document.createDocumentFragment();
    fragment.appendChild(galleryBtn);
    fragment.appendChild(cropBtn);
    fragment.appendChild(bindBtn);

    if (closeBtn) {
        controlBar.insertBefore(fragment, closeBtn);
    } else {
        controlBar.appendChild(fragment);
    }
}

jQuery(async () => {
    applyThemeBindings();
    console.log('[Avatar Cropper & Gallery] 插件已加载。后端实体文件模式启动。');

    // 使用 MutationObserver 监听放大头像弹窗的生成
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.classList.contains('zoomed_avatar')) {
                        injectButtons(node);
                    } else {
                        const zoomed = node.querySelector('.zoomed_avatar');
                        if (zoomed) injectButtons(zoomed);
                    }
                }
            });
        });
    });
    
    observer.observe(document.body, { childList: true, subtree: true });
});
