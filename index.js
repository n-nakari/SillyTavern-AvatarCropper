import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

// 初始化数据结构
if (!extension_settings.avatarCroppedImages) extension_settings.avatarCroppedImages = {};
// 存储新的图库数据结构 (存储URL而非Base64)
if (!extension_settings.stAvatarGallery) extension_settings.stAvatarGallery = { char: {}, user: [] };
// 存储主题绑定关系
if (!extension_settings.stThemeBindings) extension_settings.stThemeBindings = {};

function getAvatarIdFromSrc(src) {
    try {
        let cleanSrc = src.split('?')[0];
        const parts = cleanSrc.split('/');
        return decodeURIComponent(parts[parts.length - 1]);
    } catch (e) {
        return src;
    }
}

function getCurrentTheme() {
    const themeSelect = document.getElementById('themes');
    return themeSelect ? themeSelect.value : 'default';
}

function isUserAvatar(src) {
    return src.includes('User%20Avatars') || src.includes('User Avatars');
}

// 核心功能：将Base64图片上传至ST后端真实文件夹，避免settings.json过大
async function uploadImageToBackend(base64Url) {
    const base64Data = base64Url.split(',')[1];
    const req = {
        image: base64Data,
        format: 'png',
        ch_name: 'AvatarGallery', // 后端会自动存入 public/images/AvatarGallery 文件夹
        filename: Date.now().toString()
    };
    try {
        const res = await fetch('/api/images/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req)
        });
        const data = await res.json();
        return data.path; // 返回相对路径 URL
    } catch (err) {
        console.error("上传图片到后端失败", err);
        return null;
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
                resolve(canvas.toDataURL('image/png')); 
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

// 核心功能：使用SillyTavern原生机制替换真实头像文件
async function applyNativeAvatar(imageUrl, isUser) {
    try {
        toastr.info("正在应用新头像...");
        // 1. 获取图片数据并转换为 File 对象
        const res = await fetch(imageUrl);
        const blob = await res.blob();
        const file = new File([blob], 'avatar.png', { type: 'image/png' });

        // 2. 将 File 塞入 DataTransfer 伪造用户选择文件的动作
        const dt = new DataTransfer();
        dt.items.add(file);

        // 3. 找到原生的 input 元素
        const inputId = isUser ? 'avatar_upload_file' : 'character_replace_file';
        const input = document.getElementById(inputId);
        
        if (input) {
            input.files = dt.files;
            // 4. 触发原生 change 事件
            input.dispatchEvent(new Event('change', { bubbles: true }));
            toastr.success("头像原生替换成功！");
        } else {
            toastr.error("找不到原生上传按钮。");
        }
    } catch (e) {
        console.error(e);
        toastr.error("原生替换失败。");
    }
}

// ======================== CSS 注入引擎 (只针对聊天框 .mes 内部应用主题绑定) ========================

function applyThemeBindings() {
    const theme = getCurrentTheme();
    const bindings = extension_settings.stThemeBindings[theme] || {};
    let cssString = '';
    
    // 只针对 .mes 内部的头像进行修改
    for (const [avatarId, imageUrl] of Object.entries(bindings)) {
        if (avatarId === 'thumbnail') continue;
        const escapedId = avatarId.replace(/"/g, '\\"');
        const encodedId = encodeURIComponent(avatarId).replace(/"/g, '\\"');
        cssString += `
            #chat .mes .avatar img[src*="${escapedId}"],
            #chat .mes .avatar img[src*="${encodedId}"] {
                content: url("${imageUrl}") !important;
                object-fit: cover !important;
            }
        `;
    }

    let styleTag = document.getElementById('custom-theme-binding-style');
    if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'custom-theme-binding-style';
        document.head.appendChild(styleTag);
    }
    styleTag.textContent = cssString;
}

// ======================== 图库面板 ========================

async function openAvatarGallery(avatarId, isUser) {
    if (avatarId === 'thumbnail') return toastr.error('无法获取此头像ID');

    let galleryList = isUser ? extension_settings.stAvatarGallery.user : (extension_settings.stAvatarGallery.char[avatarId] || []);

    const html = `
        <div id="st-alt-avatar-panel">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid var(--SmartThemeBodyColor, #555); padding-bottom: 10px;">
                <h3 style="margin: 0;">${isUser ? 'User' : 'Char'} 头像图库</h3>
                <div style="display:flex; gap:10px; align-items:center;">
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-upload" title="上传图片"><i class="fa-solid fa-upload"></i></div>
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-manage" title="管理列表"><i class="fa-solid fa-trash-can"></i></div>
                    <div class="menu_button menu_button_icon margin0" id="btn-alt-delete-confirm" style="display:none; color:#ff4444;"><i class="fa-solid fa-trash-can"></i></div>
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
            // 加载最新数据
            galleryList = isUser ? extension_settings.stAvatarGallery.user : (extension_settings.stAvatarGallery.char[avatarId] || []);
            
            galleryList.forEach((url, index) => {
                const itemDiv = document.createElement('div');
                itemDiv.className = 'alt-avatar-item';
                if (itemsToDelete.has(index)) itemDiv.classList.add('to-delete');
                
                itemDiv.innerHTML = `<img src="${url}">`;
                itemDiv.onclick = (e) => {
                    if (isDeleteMode) { 
                        e.stopPropagation(); 
                        toggleDeleteMark(index, itemDiv);
                    } else { 
                        applyNativeAvatar(url, isUser);
                        document.querySelector('#dialogue_popup .cross').click(); // 关闭弹窗
                    }
                };
                grid.appendChild(itemDiv);
            });
        }

        function toggleDeleteMark(index, element) {
            if (itemsToDelete.has(index)) {
                itemsToDelete.delete(index);
                element.classList.remove('to-delete');
            } else {
                itemsToDelete.add(index);
                element.classList.add('to-delete');
            }
            btnDeleteConfirm.title = `确认删除 (${itemsToDelete.size})`;
        }
        
        btnManage.onclick = () => {
            isDeleteMode = !isDeleteMode;
            if (isDeleteMode) {
                btnManage.innerHTML = '<i class="fa-solid fa-xmark"></i>';
                btnUpload.style.display = 'none';
                btnDeleteConfirm.style.display = 'flex';
                itemsToDelete.clear();
            } else {
                btnManage.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
                btnUpload.style.display = 'flex';
                btnDeleteConfirm.style.display = 'none';
            }
            grid.classList.toggle('delete-mode', isDeleteMode);
            renderGrid();
        };

        btnDeleteConfirm.onclick = async () => {
            if (itemsToDelete.size === 0) return btnManage.click();
            const confirm = await callGenericPopup(`确认删除选中的 ${itemsToDelete.size} 张图片？(关联的主题绑定将一并清空)`, POPUP_TYPE.CONFIRM);
            if (!confirm) return;

            const indexes = Array.from(itemsToDelete).sort((a, b) => b - a);
            const deletedUrls = indexes.map(i => galleryList[i]);
            
            // 清理对应数组
            indexes.forEach((index) => galleryList.splice(index, 1));

            // 全局遍历删除对应的主题绑定数据
            if (extension_settings.stThemeBindings) {
                for (const t of Object.keys(extension_settings.stThemeBindings)) {
                    if (extension_settings.stThemeBindings[t][avatarId]) {
                        if (deletedUrls.includes(extension_settings.stThemeBindings[t][avatarId])) {
                            delete extension_settings.stThemeBindings[t][avatarId];
                        }
                    }
                }
            }

            // 如果最后一张图也删除了，恢复默认图
            if (galleryList.length === 0) {
                const defaultImage = isUser ? 'User Avatars/default.png' : 'img/ai4.png';
                applyNativeAvatar(defaultImage, isUser);
            }

            saveSettingsDebounced();
            applyThemeBindings();
            btnManage.click(); 
        };
        
        btnUpload.onclick = () => inputUpload.click();
        
        inputUpload.onchange = async (e) => {
            const files = e.target.files;
            if (!files || files.length === 0) return;
            
            toastr.info(`正在上传并处理 ${files.length} 张图片...`);
            
            if(!isUser && !extension_settings.stAvatarGallery.char[avatarId]) {
                extension_settings.stAvatarGallery.char[avatarId] = [];
            }
            const targetArray = isUser ? extension_settings.stAvatarGallery.user : extension_settings.stAvatarGallery.char[avatarId];

            for(let i = 0; i < files.length; i++) {
                const b64 = await resizeImageToBase64(files[i]);
                const savedUrl = await uploadImageToBackend(b64);
                if (savedUrl) targetArray.push(savedUrl);
            }
            
            saveSettingsDebounced();
            renderGrid();
            inputUpload.value = ''; 
            toastr.success('图片已添加入图库');
        };
        
        renderGrid();
    }, 100);
}

// ======================== 主题绑定 & 原生剪裁 ========================

async function triggerNativeCropPopup(imgSrc, avatarId, bindBtn) {
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
        toastr.info('正在保存剪裁结果并绑定到当前主题...');
        const savedUrl = await uploadImageToBackend(croppedImageBase64);
        
        if (savedUrl) {
            const theme = getCurrentTheme(); 
            if (!extension_settings.stThemeBindings[theme]) extension_settings.stThemeBindings[theme] = {};
            // 绑定到当前主题
            extension_settings.stThemeBindings[theme][avatarId] = savedUrl;
            
            saveSettingsDebounced();
            applyThemeBindings(); 
            if(bindBtn) bindBtn.classList.add('active-bind');
            toastr.success('剪裁已保存，并成功绑定至当前主题！');
        }
    }
}

// ======================== 控制栏注入 ========================

function injectControlButtons(zoomedDiv) {
    if (zoomedDiv.querySelector('#st-native-crop-btn')) return;

    const controlBar = zoomedDiv.querySelector('.panelControlBar');
    if (!controlBar) return;

    const img = zoomedDiv.querySelector('img');
    if (!img) return;

    const imgSrc = img.src;
    const avatarId = getAvatarIdFromSrc(imgSrc);
    const isUser = isUserAvatar(imgSrc);
    const currentTheme = getCurrentTheme();

    // 判断当前是否已被绑定
    const isBound = extension_settings.stThemeBindings[currentTheme] && extension_settings.stThemeBindings[currentTheme][avatarId];

    // 1. 剪裁按钮
    const btnCrop = document.createElement('div');
    btnCrop.id = 'st-native-crop-btn';
    btnCrop.className = 'st-avatar-btn';
    btnCrop.innerHTML = '<i class="fa-solid fa-crop-simple"></i>';
    btnCrop.title = '剪裁头像 (仅限聊天框内显示)';

    // 2. 绑定按钮
    const btnBind = document.createElement('div');
    btnBind.id = 'st-theme-bind-btn';
    btnBind.className = 'st-avatar-btn' + (isBound ? ' active-bind' : '');
    btnBind.innerHTML = '<i class="fa-solid fa-link"></i>';
    btnBind.title = '将当前头像绑定至此主题 (点击解除)';

    // 3. 图库按钮
    const btnGallery = document.createElement('div');
    btnGallery.id = 'st-gallery-btn';
    btnGallery.className = 'st-avatar-btn';
    btnGallery.innerHTML = '<i class="fa-solid fa-images"></i>';
    btnGallery.title = isUser ? 'User全局图库' : 'Char专属图库';

    // 绑定事件
    btnCrop.addEventListener('click', async (e) => {
        e.stopPropagation(); 
        zoomedDiv.click(); 
        await triggerNativeCropPopup(imgSrc, avatarId, btnBind);
    });

    btnBind.addEventListener('click', (e) => {
        e.stopPropagation();
        const theme = getCurrentTheme();
        if (btnBind.classList.contains('active-bind')) {
            // 解除绑定
            if (extension_settings.stThemeBindings[theme]) {
                delete extension_settings.stThemeBindings[theme][avatarId];
                btnBind.classList.remove('active-bind');
                saveSettingsDebounced();
                applyThemeBindings();
                toastr.success('已解除该主题下此头像的绑定，恢复默认。');
            }
        } else {
            // 如果用户直接点绑定，就把当前原图存下来当做绑定
            toastr.info('由于没有剪裁，将直接绑定当前原图。');
            if (!extension_settings.stThemeBindings[theme]) extension_settings.stThemeBindings[theme] = {};
            // 取消 URL 里的 host 方便跨环境
            extension_settings.stThemeBindings[theme][avatarId] = new URL(imgSrc).pathname + new URL(imgSrc).search;
            btnBind.classList.add('active-bind');
            saveSettingsDebounced();
            applyThemeBindings();
            toastr.success('已绑定当前图片至本主题！');
        }
    });

    btnGallery.addEventListener('click', (e) => {
        e.stopPropagation();
        zoomedDiv.click();
        openAvatarGallery(avatarId, isUser);
    });

    // 插入DOM
    const closeBtn = controlBar.querySelector('.dragClose');
    if (closeBtn) {
        controlBar.insertBefore(btnCrop, closeBtn);
        controlBar.insertBefore(btnBind, closeBtn);
        controlBar.insertBefore(btnGallery, closeBtn);
    } else {
        controlBar.appendChild(btnCrop);
        controlBar.appendChild(btnBind);
        controlBar.appendChild(btnGallery);
    }
}

// 监听主题切换，随时刷新绑定状态
let lastTheme = getCurrentTheme();
setInterval(() => {
    const currentTheme = getCurrentTheme();
    if (currentTheme !== lastTheme) {
        lastTheme = currentTheme;
        applyThemeBindings(); 
    }
}, 1000);

jQuery(async () => {
    applyThemeBindings();
    console.log('[AvatarGallery&Cropper] 核心已加载');

    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.classList.contains('zoomed_avatar')) injectControlButtons(node);
                    else {
                        const zoomed = node.querySelector('.zoomed_avatar');
                        if (zoomed) injectControlButtons(zoomed);
                    }
                }
            });
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });
});
