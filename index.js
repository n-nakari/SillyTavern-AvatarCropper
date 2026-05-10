import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

// 初始化数据结构
if (extension_settings.avatarClickZoomEnabled === undefined) extension_settings.avatarClickZoomEnabled = false;

// 废弃旧的 Base64 裁剪存储，改用全新主题绑定存储 (Theme Bindings)
if (!extension_settings.themeBindings) extension_settings.themeBindings = {};
// Char 图库 { avatarId: { selected: index, images: [path1, path2...] } }
if (!extension_settings.altAvatars) extension_settings.altAvatars = {};
// User 独立全局图库 { selected: index, images: [path1, path2...] }
if (!extension_settings.userGlobalGallery) extension_settings.userGlobalGallery = { selected: null, images: [] };

const USER_ID = 'USER_GLOBAL';

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

function getCurrentTheme() {
    const themeSelect = document.getElementById('themes');
    return themeSelect ? themeSelect.value : 'default';
}

function isUserAvatar(zoomedDiv, src) {
    if (zoomedDiv && zoomedDiv.hasAttribute('forchar') && zoomedDiv.getAttribute('forchar') !== '') return false;
    if (src.includes('User%20Avatars') || src.includes('user_avatar')) return true;
    const curAvatar = document.querySelector('#curAvatar img');
    if (curAvatar && curAvatar.src === src) return true;
    return false;
}

// 记录当前有效的文件名
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

// ======================== 与后端交互 (实体文件存储) ========================

async function uploadImageToServer(base64Data, filename) {
    try {
        const pureB64 = base64Data.split(',')[1];
        const match = base64Data.match(/data:image\/(.*?);base64/);
        const ext = match ? match[1] : 'png';
        const cleanName = filename.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_]/g, '') + '_' + Date.now();
        
        const req = {
            image: pureB64,
            format: ext,
            ch_name: 'avatars_gallery', // 自动保存在 data/default-user/user/images/avatars_gallery 下
            filename: cleanName
        };

        const res = await fetch('/api/images/upload', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': window['csrf_token']
            },
            body: JSON.stringify(req)
        });

        if (res.ok) {
            const data = await res.json();
            return data.path; // 返回真实路径
        }
    } catch (e) {
        console.error("[AvatarGallery] Upload Error:", e);
    }
    return null;
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

async function getBase64FromUrl(url) {
    if (url.startsWith('data:image')) return url;
    const data = await fetch(url);
    const blob = await data.blob();
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.readAsDataURL(blob); 
        reader.onloadend = () => resolve(reader.result);
    });
}

// 清除被删除图片的绑定数据
function removePathFromBindings(path) {
    for (let theme in extension_settings.themeBindings) {
        for (let id in extension_settings.themeBindings[theme]) {
            if (extension_settings.themeBindings[theme][id] === path) {
                delete extension_settings.themeBindings[theme][id];
            }
        }
    }
}

// ======================== CSS 渲染核心 (主题绑定优先于图库) ========================

function getAvatarCss(avatarId, imagePath) {
    if (avatarId === USER_ID) {
        // 用户头像的覆盖
        return `
            .mes[is_user="true"] .avatar img,
            .mes[is_user="true"] .avatarWrapper img,
            #user_avatar_block .avatar img,
            #curAvatar img,
            .zoomed_avatar[forchar=""] img {
                content: url("${imagePath}") !important;
                object-fit: cover !important;
            }
        `;
    } else {
        // 角色头像的覆盖
        const escapedId = avatarId.replace(/"/g, '\\"');
        const encodedId = encodeURIComponent(avatarId).replace(/"/g, '\\"');
        return `
            .avatar img[src*="${escapedId}"],
            .avatar img[src*="${encodedId}"],
            #avatar_load_preview[src*="${escapedId}"],
            #avatar_load_preview[src*="${encodedId}"],
            .zoomed_avatar[forchar] img[src*="${escapedId}"],
            .zoomed_avatar[forchar] img[src*="${encodedId}"] {
                content: url("${imagePath}") !important;
                object-fit: cover !important;
            }
        `;
    }
}

function applyAvatars() {
    let cssString = '';
    const theme = getCurrentTheme();

    // 1. 处理 User 独立图库/绑定
    let userImg = null;
    if (extension_settings.themeBindings[theme] && extension_settings.themeBindings[theme][USER_ID]) {
        userImg = extension_settings.themeBindings[theme][USER_ID]; // 绑定优先级最高
    } else if (extension_settings.userGlobalGallery.selected !== null && extension_settings.userGlobalGallery.images[extension_settings.userGlobalGallery.selected]) {
        userImg = extension_settings.userGlobalGallery.images[extension_settings.userGlobalGallery.selected]; // 其次是图库选中
    }
    if (userImg) cssString += getAvatarCss(USER_ID, userImg);

    // 2. 处理 Char 独立图库/绑定
    const charKeys = new Set([
        ...Object.keys(extension_settings.altAvatars),
        ...Object.keys(extension_settings.themeBindings[theme] || {})
    ]);

    for (let avatarId of charKeys) {
        if (avatarId === USER_ID || avatarId === 'thumbnail') continue;

        let charImg = null;
        if (extension_settings.themeBindings[theme] && extension_settings.themeBindings[theme][avatarId]) {
            charImg = extension_settings.themeBindings[theme][avatarId]; // 绑定优先
        } else if (extension_settings.altAvatars[avatarId] && extension_settings.altAvatars[avatarId].selected !== null && extension_settings.altAvatars[avatarId].images[extension_settings.altAvatars[avatarId].selected]) {
            charImg = extension_settings.altAvatars[avatarId].images[extension_settings.altAvatars[avatarId].selected];
        }
        if (charImg) cssString += getAvatarCss(avatarId, charImg);
    }

    let styleTag = document.getElementById('custom-avatar-dynamic-style');
    if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'custom-avatar-dynamic-style';
        document.head.appendChild(styleTag);
    }
    styleTag.textContent = cssString;
}

// ======================== 图库面板 (独立功能) ========================

async function openGalleryPanel(avatarId, isUser, originalSrc) {
    if (!isUser && !extension_settings.altAvatars[avatarId]) {
        extension_settings.altAvatars[avatarId] = { selected: null, images: [] };
    }
    const data = isUser ? extension_settings.userGlobalGallery : extension_settings.altAvatars[avatarId];
    
    // 生成顶部栏
    let topBarExtra = '';
    if (!isUser) {
        topBarExtra = `
            <div class="menu_button menu_button_icon margin0" id="btn-gallery-export" title="导出角色图库"><i class="fa-solid fa-file-export"></i></div>
            <div class="menu_button menu_button_icon margin0" id="btn-gallery-import" title="导入角色图库"><i class="fa-solid fa-file-import"></i></div>
        `;
    }

    const html = `
        <div id="st-alt-avatar-panel">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid var(--SmartThemeBodyColor, #555); padding-bottom: 10px;">
                <h3 style="margin: 0;">${isUser ? '用户专属图库' : '角色图库'}</h3>
                <div style="display:flex; gap:10px; align-items:center;">
                    ${topBarExtra}
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-upload" title="上传图片"><i class="fa-solid fa-upload"></i></div>
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-manage" title="管理列表"><i class="fa-solid fa-trash-can"></i></div>
                    <div id="btn-alt-delete-confirm" title="确认删除"><i class="fa-solid fa-trash-can"></i> <span>确认删除 (0)</span></div>
                </div>
            </div>
            <input type="file" id="input-alt-upload" style="display:none;" accept="image/*" multiple>
            <div class="alt-avatar-grid" id="grid-alt-avatars"></div>
        </div>
    `;
    
    let tempSelected = data.selected; 

    // 只有点击【确认】才应用变更
    callGenericPopup(html, POPUP_TYPE.CONFIRM, '', { wide: true, large: true }).then((confirm) => {
        if (confirm) {
            data.selected = tempSelected;
            saveSettingsDebounced();
            applyAvatars(); 
            toastr.success('已应用所选头像');
        }
    });
    
    setTimeout(() => {
        const grid = document.getElementById('grid-alt-avatars');
        if(!grid) return;

        const btnUpload = document.getElementById('btn-alt-upload');
        const btnManage = document.getElementById('btn-alt-manage');
        const btnDeleteConfirm = document.getElementById('btn-alt-delete-confirm');
        const inputUpload = document.getElementById('input-alt-upload');
        
        let isDeleteMode = false;
        let itemsToDelete = new Set();
        
        function updateDeleteConfirmBtn() {
            btnDeleteConfirm.querySelector('span').innerText = `确认删除 (${itemsToDelete.size})`;
        }

        function renderGrid() {
            grid.innerHTML = '';
            
            // 原始图片
            const origDiv = document.createElement('div');
            origDiv.className = 'alt-avatar-item original-item' + (tempSelected === null ? ' selected' : '');
            origDiv.innerHTML = `<img src="${originalSrc}" title="默认头像" onerror="this.src='img/ai4.png'">`;
            origDiv.onclick = () => selectAvatar(null);
            grid.appendChild(origDiv);
            
            // 图库图片
            data.images.forEach((path, index) => {
                const itemDiv = document.createElement('div');
                itemDiv.className = 'alt-avatar-item' + (tempSelected === index ? ' selected' : '');
                if (itemsToDelete.has(index)) itemDiv.classList.add('to-delete');
                
                itemDiv.innerHTML = `<img src="${path}">`;
                itemDiv.onclick = (e) => {
                    if (isDeleteMode) { 
                        e.stopPropagation(); 
                        toggleDeleteMark(index, itemDiv);
                    } else { 
                        selectAvatar(index); 
                    }
                };
                grid.appendChild(itemDiv);
            });
        }
        
        function selectAvatar(index) {
            if (isDeleteMode) return;
            tempSelected = index;
            renderGrid();
        }

        function toggleDeleteMark(index, element) {
            if (itemsToDelete.has(index)) {
                itemsToDelete.delete(index);
                element.classList.remove('to-delete');
            } else {
                itemsToDelete.add(index);
                element.classList.add('to-delete');
            }
            updateDeleteConfirmBtn();
        }
        
        btnManage.onclick = () => {
            isDeleteMode = !isDeleteMode;
            if (isDeleteMode) {
                btnManage.innerHTML = '<i class="fa-solid fa-xmark"></i>';
                btnManage.title = '退出管理';
                btnUpload.style.display = 'none';
                btnDeleteConfirm.style.display = 'flex';
                if (!isUser) {
                    document.getElementById('btn-gallery-export').style.display = 'none';
                    document.getElementById('btn-gallery-import').style.display = 'none';
                }
                itemsToDelete.clear();
                updateDeleteConfirmBtn();
            } else {
                btnManage.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
                btnManage.title = '管理列表';
                btnUpload.style.display = 'flex';
                btnDeleteConfirm.style.display = 'none';
                if (!isUser) {
                    document.getElementById('btn-gallery-export').style.display = 'flex';
                    document.getElementById('btn-gallery-import').style.display = 'flex';
                }
                itemsToDelete.clear();
            }
            grid.classList.toggle('delete-mode', isDeleteMode);
            renderGrid();
        };

        btnDeleteConfirm.onclick = async () => {
            if (itemsToDelete.size === 0) return btnManage.click();
            const confirm = await callGenericPopup(`确认删除选中的 ${itemsToDelete.size} 张图片？这将同时清除它们的绑定数据。`, POPUP_TYPE.CONFIRM);
            if (!confirm) return;

            const indexes = Array.from(itemsToDelete).sort((a, b) => b - a);
            indexes.forEach((index) => {
                const deletedPath = data.images[index];
                // 核心：图片被删后，解绑该图片所有绑定关系
                removePathFromBindings(deletedPath);

                if (data.selected === index) data.selected = null; // 最后一张被删回退默认
                else if (data.selected > index) data.selected -= 1;
                
                if (tempSelected === index) tempSelected = null;
                else if (tempSelected > index) tempSelected -= 1;
                
                data.images.splice(index, 1);
            });

            saveSettingsDebounced();
            applyAvatars(); // 实时移除失效的绑定显示
            btnManage.click(); 
            toastr.success('删除成功');
        };
        
        btnUpload.onclick = () => inputUpload.click();
        
        inputUpload.onchange = async (e) => {
            const files = e.target.files;
            if (!files || files.length === 0) return;
            toastr.info(`正在上传 ${files.length} 张图片到后端...`);
            
            for(let i = 0; i < files.length; i++) {
                const b64 = await resizeImageToBase64(files[i]);
                const path = await uploadImageToServer(b64, avatarId + '_img');
                if (path) data.images.push(path);
            }
            
            saveSettingsDebounced();
            renderGrid();
            inputUpload.value = ''; 
            toastr.success('上传完成');
        };

        // 导入与导出逻辑
        if (!isUser) {
            document.getElementById('btn-gallery-export').onclick = async () => {
                if (data.images.length === 0) return toastr.warning('图库为空');
                toastr.info('正在打包图库，请稍候...');
                const exportData = [];
                for (let path of data.images) {
                    const b64 = await getBase64FromUrl(path);
                    exportData.push(b64);
                }
                const blob = new Blob([JSON.stringify(exportData)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${avatarId}_Gallery_Export.json`;
                a.click();
                URL.revokeObjectURL(url);
            };

            document.getElementById('btn-gallery-import').onclick = () => {
                const importInput = document.createElement('input');
                importInput.type = 'file';
                importInput.accept = '.json';
                importInput.onchange = (e) => {
                    const file = e.target.files[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = async (ev) => {
                        try {
                            const b64Array = JSON.parse(ev.target.result);
                            toastr.info(`正在导入 ${b64Array.length} 张图片...`);
                            for (let b64 of b64Array) {
                                const path = await uploadImageToServer(b64, avatarId + '_import');
                                if (path) data.images.push(path);
                            }
                            saveSettingsDebounced();
                            renderGrid();
                            toastr.success('导入完成');
                        } catch (err) {
                            toastr.error('导入失败，文件格式不正确');
                        }
                    };
                    reader.readAsText(file);
                };
                importInput.click();
            };
        }
        
        renderGrid();
    }, 100);
}

// ======================== 原生剪裁弹窗 & 绑定机制 ========================

async function triggerNativeCropPopup(imgSrc, avatarId) {
    const base64Original = await getBase64FromUrl(imgSrc);
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
        // 剪裁后上传后端并自动绑定到当前主题
        const path = await uploadImageToServer(croppedImageBase64, avatarId + '_crop');
        if (path) {
            const theme = getCurrentTheme(); 
            if (!extension_settings.themeBindings[theme]) extension_settings.themeBindings[theme] = {};
            extension_settings.themeBindings[theme][avatarId] = path;
            
            saveSettingsDebounced();
            applyAvatars(); 
            toastr.success('已自动将裁剪图片绑定至当前主题');
        }
    }
}

// 绑定/解绑当前显示的图片到当前主题
async function toggleBindState(avatarId, isUser, currentImgSrc, btnBind) {
    const theme = getCurrentTheme();
    if (!extension_settings.themeBindings[theme]) extension_settings.themeBindings[theme] = {};

    if (extension_settings.themeBindings[theme][avatarId]) {
        // 解绑
        delete extension_settings.themeBindings[theme][avatarId];
        btnBind.classList.remove('bound');
        toastr.info('已解除此美化主题的头像绑定，恢复默认设置');
    } else {
        // 绑定：如果 src 是 blob 或 data URL，先传后端，否则直接用当前 path
        let bindPath = currentImgSrc;
        if (bindPath.startsWith('blob:') || bindPath.startsWith('data:')) {
            bindPath = await uploadImageToServer(bindPath, avatarId + '_bind');
        }
        if (bindPath) {
            extension_settings.themeBindings[theme][avatarId] = bindPath;
            btnBind.classList.add('bound');
            toastr.success('已将当前头像绑定至该主题');
        }
    }
    saveSettingsDebounced();
    applyAvatars();
}

// 注入按钮到大图控制面板
function injectButtons(zoomedDiv) {
    if (zoomedDiv.querySelector('#st-native-crop-btn')) return;

    const controlBar = zoomedDiv.querySelector('.panelControlBar');
    if (!controlBar) return;

    const img = zoomedDiv.querySelector('img');
    if (!img) return;
    
    const src = img.src;
    const isUser = isUserAvatar(zoomedDiv, src);
    const avatarId = isUser ? USER_ID : getAvatarIdFromSrc(src);

    // 1. 图库按钮
    const btnGallery = document.createElement('div');
    btnGallery.className = 'st-avatar-btn';
    btnGallery.innerHTML = '<i class="fa-solid fa-images"></i>';
    btnGallery.title = isUser ? '用户全局图库' : '角色图库';
    btnGallery.addEventListener('click', (e) => {
        e.stopPropagation();
        zoomedDiv.click(); // 关闭放大面板
        openGalleryPanel(avatarId, isUser, src);
    });

    // 2. 剪裁按钮
    const btnCrop = document.createElement('div');
    btnCrop.id = 'st-native-crop-btn';
    btnCrop.className = 'st-avatar-btn';
    btnCrop.innerHTML = '<i class="fa-solid fa-crop-simple"></i>';
    btnCrop.title = '剪裁头像';
    btnCrop.addEventListener('click', async (e) => {
        e.stopPropagation(); 
        zoomedDiv.click(); 
        await triggerNativeCropPopup(img.src, avatarId);
    });

    // 3. 绑定按钮
    const btnBind = document.createElement('div');
    btnBind.className = 'st-avatar-btn';
    btnBind.innerHTML = '<i class="fa-solid fa-link"></i>';
    btnBind.title = '绑定当前头像至此主题';
    
    // 初始化按钮颜色状态
    const theme = getCurrentTheme();
    if (extension_settings.themeBindings[theme] && extension_settings.themeBindings[theme][avatarId]) {
        btnBind.classList.add('bound');
    }
    
    btnBind.addEventListener('click', async (e) => {
        e.stopPropagation();
        await toggleBindState(avatarId, isUser, img.src, btnBind);
    });

    // 按顺序插入
    const closeBtn = controlBar.querySelector('.dragClose');
    if (closeBtn) {
        controlBar.insertBefore(btnBind, closeBtn);
        controlBar.insertBefore(btnGallery, btnBind);
        controlBar.insertBefore(btnCrop, btnGallery);
    } else {
        controlBar.appendChild(btnCrop);
        controlBar.appendChild(btnGallery);
        controlBar.appendChild(btnBind);
    }
}

// ======================== 全局监听与初始化 ========================

let lastTheme = getCurrentTheme();
let lastEntity = null; // 监控 char 或 user 的切换

setInterval(() => {
    const currentTheme = getCurrentTheme();
    
    // 监控当前实际预览的头像ID
    const previewImg = document.getElementById('avatar_load_preview');
    let currentEntity = null;
    if (previewImg && previewImg.getAttribute('src')) {
        currentEntity = getAvatarIdFromSrc(previewImg.getAttribute('src'));
    }

    if (currentTheme !== lastTheme || currentEntity !== lastEntity) {
        lastTheme = currentTheme;
        lastEntity = currentEntity;
        applyAvatars(); // 切换美化或人物时实时刷新绑定展示
    }

    // 注入开启点击缩放的控制项 (UI-Theme-Block)
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
    } catch (e) {}
}, 1000);

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
            #chat .mes .mesAvatarWrapper .avatar img {
                pointer-events: auto !important;
            }
        `;
    } else if (pointerStyle) {
        pointerStyle.remove();
    }
}

jQuery(async () => {
    // 数据清理（兼容移除旧的 Base64 裁剪逻辑）
    if (extension_settings.avatarCroppedImages) {
        delete extension_settings.avatarCroppedImages;
        saveSettingsDebounced();
    }

    applyAvatars();
    updateClickZoomState();

    console.log('[AvatarGallery&Binder] Successfully Loaded.');

    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.classList.contains('zoomed_avatar')) injectButtons(node);
                    else {
                        const zoomed = node.querySelector('.zoomed_avatar');
                        if (zoomed) injectButtons(zoomed);
                    }
                }
            });
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });
});
