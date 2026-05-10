import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

// 初始化数据结构
// gallery 结构: { user: [url1, url2...], chars: { 'charName.png': [url1...] } }
if (!extension_settings.avatarGallery) extension_settings.avatarGallery = { user: [], chars: {} };
// themeBinds 结构: { 'themeName': { 'user_xxx.png': url, 'char_xxx.png': url } }
if (!extension_settings.themeBinds) extension_settings.themeBinds = {};

// ======================== 核心辅助函数 ========================

// 从 src 解析出当前头像的身份与真实文件名
function parseAvatarSrc(src) {
    if (!src) return null;
    let cleanSrc = src.split('?')[0];
    const isUser = cleanSrc.includes('User Avatars') || cleanSrc.includes('thumbnails/persona');
    
    let id;
    try {
        const urlObj = new URL(src, window.location.origin);
        const fileParam = urlObj.searchParams.get('file') || urlObj.searchParams.get('avatar');
        id = fileParam ? decodeURIComponent(fileParam) : decodeURIComponent(urlObj.pathname.split('/').pop());
    } catch (e) {
        id = decodeURIComponent(cleanSrc.split('/').pop());
    }
    
    // 返回真实的图片文件名用于精准替换，User统一标记类型以便处理
    return { type: isUser ? 'user' : 'char', id: id };
}

function getCurrentTheme() {
    const themeSelect = document.getElementById('themes');
    return themeSelect ? themeSelect.value : 'default';
}

// 调用原生API保存Base64为实体文件，并返回相对路径
async function saveToBackend(base64Str, fileName) {
    try {
        let base64Data = base64Str;
        if (base64Str.includes(',')) base64Data = base64Str.split(',')[1];

        const response = await fetch('/api/images/upload', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                image: base64Data,
                format: 'png',
                ch_name: 'Extension_AvatarGallery',
                filename: fileName.replace(/\./g, '_') + '_' + Date.now()
            })
        });
        if (response.ok) {
            const data = await response.json();
            return data.path; // 返回相对路径 e.g., user/images/...
        }
    } catch (error) {
        console.error('Failed to save image to backend:', error);
    }
    return null;
}

// 调用原生API删除文件
async function deleteFromBackend(url) {
    if (!url || url.startsWith('data:')) return;
    try {
        await fetch('/api/images/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ path: url })
        });
    } catch (e) { }
}

async function getBase64FromUrl(url) {
    if (url.startsWith('data:image')) return url;
    const fetchUrl = url.startsWith('/') || url.startsWith('http') ? url : `/${url}`;
    const data = await fetch(fetchUrl);
    const blob = await data.blob();
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onloadend = () => resolve(reader.result);
    });
}

// 压缩上传的图片以供图库使用
async function resizeImageToBase64(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const MAX_SIZE = 1000;
                let width = img.width, height = img.height;
                if (width > height && width > MAX_SIZE) {
                    height *= MAX_SIZE / width; width = MAX_SIZE;
                } else if (height > MAX_SIZE) {
                    width *= MAX_SIZE / height; height = MAX_SIZE;
                }
                canvas.width = width; canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/png'));
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

// 模拟触发原生的ST上传和替换逻辑 (核心黑科技)
async function triggerNativeUpload(imgUrl, avatarInfo) {
    try {
        toastr.info("正在调动系统替换头像，请确认后续弹窗...", "系统处理中");
        
        const fetchUrl = imgUrl.startsWith('/') || imgUrl.startsWith('http') ? imgUrl : `/${imgUrl}`;
        const response = await fetch(fetchUrl);
        
        if (!response.ok) throw new Error("File not found");
        
        const blob = await response.blob();
        // 伪装成一个正常的PNG上传文件
        const file = new File([blob], `gallery_replaced_${Date.now()}.png`, { type: 'image/png' });
        
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);

        if (avatarInfo.type === 'user') {
            // 对 Persona 头像特殊处理：必须告诉 ST 覆盖哪个特定的用户头像文件
            $('#avatar_upload_overwrite').val(avatarInfo.id);
            const fileInput = document.getElementById('avatar_upload_file');
            fileInput.files = dataTransfer.files;
            $(fileInput).trigger('change');
        } else {
            // 角色头像替换
            const fileInput = document.getElementById('character_replace_file');
            fileInput.files = dataTransfer.files;
            $(fileInput).trigger('change');
        }
    } catch (e) {
        console.error("Native upload trigger failed:", e);
        toastr.error("触发原生替换失败，请检查浏览器控制台");
    }
}

// ======================== CSS 生成引擎 ========================

function applyThemeBinds() {
    const theme = getCurrentTheme();
    const currentBinds = extension_settings.themeBinds[theme] || {};
    let cssString = '';

    for (const [id, url] of Object.entries(currentBinds)) {
        if (!url) continue;
        
        const escapedId = id.replace(/"/g, '\\"');
        const encodedId = encodeURIComponent(id).replace(/"/g, '\\"');
        const finalUrl = url.startsWith('/') || url.startsWith('http') || url.startsWith('data:') ? url : `/${url}`;
        
        // 严格限定选择器，仅改变聊天框内部（#chat .mes）的匹配头像，不污染全局侧边栏和列表
        const selector = `#chat .mes .avatar img[src*="${escapedId}"], #chat .mes .avatar img[src*="${encodedId}"]`;

        cssString += `
            ${selector} {
                content: url("${finalUrl}") !important;
                object-fit: cover !important;
            }
        `;
    }

    let styleTag = document.getElementById('st-avatar-crop-style');
    if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'st-avatar-crop-style';
        document.head.appendChild(styleTag);
    }
    styleTag.textContent = cssString;
}

// ======================== UI注入面板 ========================

function injectControlButtons(zoomedDiv) {
    const controlBar = zoomedDiv.querySelector('.panelControlBar');
    if (!controlBar || controlBar.querySelector('#st-gallery-btn')) return;

    const img = zoomedDiv.querySelector('img');
    const avatarInfo = parseAvatarSrc(img.src);
    if (!avatarInfo) return;

    const theme = getCurrentTheme();
    const binds = extension_settings.themeBinds[theme] || {};
    const isBound = !!binds[avatarInfo.id];

    // 图库按钮
    const galleryBtn = document.createElement('div');
    galleryBtn.id = 'st-gallery-btn';
    galleryBtn.className = 'st-avatar-ctrl-btn';
    galleryBtn.innerHTML = '<i class="fa-solid fa-images"></i>';
    galleryBtn.title = '打开独立图库';
    galleryBtn.onclick = (e) => { e.stopPropagation(); zoomedDiv.click(); openGallery(avatarInfo); };

    // 剪裁按钮
    const cropBtn = document.createElement('div');
    cropBtn.id = 'st-native-crop-btn';
    cropBtn.className = 'st-avatar-ctrl-btn';
    cropBtn.innerHTML = '<i class="fa-solid fa-crop-simple"></i>';
    cropBtn.title = '剪裁图片并绑定至当前美化';
    cropBtn.onclick = (e) => { e.stopPropagation(); zoomedDiv.click(); triggerCropPopup(img.src, avatarInfo); };

    // 绑定按钮
    const bindBtn = document.createElement('div');
    bindBtn.id = 'st-bind-btn';
    bindBtn.className = `st-avatar-ctrl-btn ${isBound ? 'is-bound' : ''}`;
    bindBtn.innerHTML = '<i class="fa-solid fa-link"></i>';
    bindBtn.title = isBound ? '已绑定当前聊天气泡样式 (点击解除绑定)' : '未绑定气泡样式 (点击绑定当前图片)';
    bindBtn.onclick = async (e) => {
        e.stopPropagation();
        toggleBind(avatarInfo.id, img.src, bindBtn);
    };

    const closeBtn = controlBar.querySelector('.dragClose');
    if (closeBtn) {
        controlBar.insertBefore(bindBtn, closeBtn);
        controlBar.insertBefore(cropBtn, bindBtn);
        controlBar.insertBefore(galleryBtn, cropBtn);
    }
}

// ======================== 功能逻辑 ========================

// 绑定/解绑逻辑
async function toggleBind(targetId, currentImgSrc, btnElement) {
    const theme = getCurrentTheme();
    if (!extension_settings.themeBinds[theme]) extension_settings.themeBinds[theme] = {};
    
    const isBound = !!extension_settings.themeBinds[theme][targetId];

    if (isBound) {
        // 解除绑定
        delete extension_settings.themeBinds[theme][targetId];
        btnElement.classList.remove('is-bound');
        btnElement.title = '未绑定气泡样式 (点击绑定当前图片)';
        toastr.info('已解除该角色/用户在此主题下的头像绑定，恢复默认。');
    } else {
        // 绑定当前图片
        const base64 = await getBase64FromUrl(currentImgSrc);
        const savedUrl = await saveToBackend(base64, `bind_${targetId}`);
        extension_settings.themeBinds[theme][targetId] = savedUrl || currentImgSrc;
        btnElement.classList.add('is-bound');
        btnElement.title = '已绑定当前聊天气泡样式 (点击解除绑定)';
        toastr.success('当前图片已绑定至此主题的聊天气泡中！');
    }
    
    saveSettingsDebounced();
    applyThemeBinds();
}

// 剪裁逻辑 -> 自动绑定
async function triggerCropPopup(imgSrc, avatarInfo) {
    const base64Original = await getBase64FromUrl(imgSrc);
    const cropPromise = callGenericPopup('', POPUP_TYPE.CROP, '', { cropAspect: 1, cropImage: base64Original });

    setTimeout(() => {
        const cropperImg = document.querySelector('#dialogue_popup .cropper-hidden');
        if (cropperImg && cropperImg.cropper) {
            cropperImg.cropper.setDragMode('move');
            cropperImg.cropper.options.wheelZoomRatio = 0.05;
        }
    }, 150);

    const croppedImageBase64 = await cropPromise;
    if (croppedImageBase64) {
        const savedUrl = await saveToBackend(croppedImageBase64, `crop_${avatarInfo.id}`);
        if (!savedUrl) return toastr.error("保存剪裁图片失败");

        const theme = getCurrentTheme();
        if (!extension_settings.themeBinds[theme]) extension_settings.themeBinds[theme] = {};
        extension_settings.themeBinds[theme][avatarInfo.id] = savedUrl;
        
        saveSettingsDebounced();
        applyThemeBinds();
        toastr.success('已剪裁并自动应用到当前主题下的聊天气泡中！');
    }
}

// 独立图库逻辑
async function openGallery(avatarInfo) {
    // 用户图库跨 Persona 保留所有图，角色图库各自独立
    const galleryKey = avatarInfo.type === 'user' ? 'user' : avatarInfo.id;
    
    let images = [];
    if (avatarInfo.type === 'user') {
        images = extension_settings.avatarGallery.user;
    } else {
        if (!extension_settings.avatarGallery.chars[galleryKey]) extension_settings.avatarGallery.chars[galleryKey] = [];
        images = extension_settings.avatarGallery.chars[galleryKey];
    }

    const html = `
        <div id="st-alt-avatar-panel">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid var(--SmartThemeBodyColor, #555); padding-bottom: 10px;">
                <h3 style="margin: 0;">${avatarInfo.type === 'user' ? '用户专属图库' : '角色专属图库'}</h3>
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

    let selectedUrl = null;

    callGenericPopup(html, POPUP_TYPE.CONFIRM, '', { wide: true, large: true }).then((confirm) => {
        if (confirm && selectedUrl) {
            // 点击 OK，触发核心的 ST 文件替换逻辑
            triggerNativeUpload(selectedUrl, avatarInfo);
        }
    });

    setTimeout(() => {
        const grid = document.getElementById('grid-alt-avatars');
        if (!grid) return;

        let isDeleteMode = false;
        let itemsToDelete = new Set();

        function renderGrid() {
            grid.innerHTML = '';
            images.forEach((url, index) => {
                const itemDiv = document.createElement('div');
                itemDiv.className = 'alt-avatar-item' + (selectedUrl === url ? ' selected' : '');
                if (itemsToDelete.has(index)) itemDiv.classList.add('to-delete');
                
                // 确保正确解析相对路径供本地显示
                const displayUrl = url.startsWith('/') || url.startsWith('http') || url.startsWith('data:') ? url : `/${url}`;
                itemDiv.innerHTML = `<img src="${displayUrl}">`;
                
                itemDiv.onclick = (e) => {
                    if (isDeleteMode) {
                        e.stopPropagation();
                        itemsToDelete.has(index) ? itemsToDelete.delete(index) : itemsToDelete.add(index);
                        document.getElementById('btn-alt-delete-confirm').title = `确认删除 (${itemsToDelete.size})`;
                        renderGrid();
                    } else {
                        selectedUrl = url;
                        renderGrid();
                    }
                };
                grid.appendChild(itemDiv);
            });
        }

        document.getElementById('btn-alt-upload').onclick = () => document.getElementById('input-alt-upload').click();
        
        // 上传新图片并存入后端实体文件
        document.getElementById('input-alt-upload').onchange = async (e) => {
            const files = e.target.files;
            if (!files.length) return;
            toastr.info(`正在处理 ${files.length} 张图片并保存至硬盘...`);
            
            for(let i = 0; i < files.length; i++) {
                const b64 = await resizeImageToBase64(files[i]);
                const savedUrl = await saveToBackend(b64, `gallery_${galleryKey}`);
                if (savedUrl) images.push(savedUrl);
            }
            saveSettingsDebounced();
            renderGrid();
            document.getElementById('input-alt-upload').value = '';
        };

        const btnManage = document.getElementById('btn-alt-manage');
        const btnDeleteConfirm = document.getElementById('btn-alt-delete-confirm');

        btnManage.onclick = () => {
            isDeleteMode = !isDeleteMode;
            btnManage.innerHTML = isDeleteMode ? '<i class="fa-solid fa-xmark"></i>' : '<i class="fa-solid fa-trash-can"></i>';
            document.getElementById('btn-alt-upload').style.display = isDeleteMode ? 'none' : 'flex';
            btnDeleteConfirm.style.display = isDeleteMode ? 'flex' : 'none';
            itemsToDelete.clear();
            btnDeleteConfirm.title = `确认删除 (0)`;
            renderGrid();
        };

        btnDeleteConfirm.onclick = async () => {
            if (itemsToDelete.size === 0) return btnManage.click();
            const indexes = Array.from(itemsToDelete).sort((a, b) => b - a);
            
            indexes.forEach((index) => {
                const urlToDelete = images[index];
                images.splice(index, 1);
                deleteFromBackend(urlToDelete); // 发送请求删除硬盘文件

                // 清理所有美化主题中对该被删图片的绑定
                for (const t of Object.keys(extension_settings.themeBinds)) {
                    if (extension_settings.themeBinds[t][avatarInfo.id] === urlToDelete) {
                        delete extension_settings.themeBinds[t][avatarInfo.id];
                    }
                }
            });

            saveSettingsDebounced();
            applyThemeBinds();
            btnManage.click();
            toastr.success('已删除选中图片并清理绑定记录');
        };

        renderGrid();
    }, 100);
}

// ======================== 主进程监控 ========================

let lastTheme = getCurrentTheme();

// 使用定时器随时监听主题变动，以确保即时应用正确的绑定样式
setInterval(() => {
    const currentTheme = getCurrentTheme();
    if (currentTheme !== lastTheme) {
        lastTheme = currentTheme;
        applyThemeBinds();
    }
}, 1000);

jQuery(async () => {
    applyThemeBinds();
    console.log('[Avatar & Gallery Controller] Successfully Loaded.');

    // 监听放大头像弹窗的生成，精准插入专属按钮
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
