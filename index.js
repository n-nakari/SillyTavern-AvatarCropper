import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

// 初始化数据结构
// galleryImages 结构: { user: [url1, url2...], chars: { 'charName': [url1...] } }
if (!extension_settings.avatarGallery) extension_settings.avatarGallery = { user: [], chars: {} };
// themeBinds 结构: { 'themeName': { 'user': url, 'charName': url } }
if (!extension_settings.themeBinds) extension_settings.themeBinds = {};

// ======================== 核心辅助函数 ========================

// 从src解析出当前头像的身份 (User 或 Char)
function parseAvatarSrc(src) {
    if (!src) return null;
    let cleanSrc = src.split('?')[0];
    const isUser = cleanSrc.includes('User Avatars') || cleanSrc.includes('thumbnails/persona');
    
    try {
        const urlObj = new URL(src, window.location.origin);
        const fileParam = urlObj.searchParams.get('file') || urlObj.searchParams.get('avatar');
        let id = fileParam ? decodeURIComponent(fileParam) : decodeURIComponent(urlObj.pathname.split('/').pop());
        return { type: isUser ? 'user' : 'char', id: isUser ? 'user' : id }; // User全局共用'user'键，Char用独立文件名
    } catch (e) {
        let id = decodeURIComponent(cleanSrc.split('/').pop());
        return { type: isUser ? 'user' : 'char', id: isUser ? 'user' : id };
    }
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
    const data = await fetch(url);
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

// 模拟触发原生的ST上传和替换逻辑 (修复版)
async function triggerNativeUpload(imgUrl, type) {
    try {
        toastr.info("正在提取图库数据...", "系统提示");
        
        // 修复Fetch路径问题，确保相对路径加上斜杠
        let fetchUrl = imgUrl;
        if (!fetchUrl.startsWith('http') && !fetchUrl.startsWith('data:') && !fetchUrl.startsWith('/')) {
            fetchUrl = '/' + fetchUrl;
        }
        
        const response = await fetch(fetchUrl);
        if (!response.ok) throw new Error("无法读取图片实体文件");
        
        const blob = await response.blob();
        // 必须模拟成标准的 PNG File 格式，ST 原生才能识别
        const file = new File([blob], `avatar_replaced_${Date.now()}.png`, { type: 'image/png' });

        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);

        let inputId = type === 'user' ? 'avatar_upload_file' : 'character_replace_file';
        const fileInput = document.getElementById(inputId);
        
        if (fileInput) {
            fileInput.files = dataTransfer.files;
            
            // 修复核心：必须使用 jQuery 的 trigger，因为 ST 原生的事件都是用 jQuery 绑定的
            $(fileInput).trigger('change');
            
            if (type === 'char') {
                toastr.success("已发送替换请求！请留意屏幕中间弹出的原生确认框，选择【Use as Image / 用作图片】以覆盖。");
            } else {
                toastr.success("用户的全局头像已替换完毕！");
            }
        } else {
            toastr.error(`找不到 ST 原生的上传控件: ${inputId}`);
        }
    } catch (e) {
        console.error("Native upload trigger failed:", e);
        toastr.error("触发原生替换失败: " + e.message);
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
        
        // 限定：只作用于聊天区内的消息头像气泡
        let selector = '';
        if (id === 'user') {
            selector = `#chat .mes[is_user="true"] .avatar img`;
        } else {
            selector = `#chat .mes .avatar img[src*="${escapedId}"], #chat .mes .avatar img[src*="${encodedId}"]`;
        }

        cssString += `
            ${selector} {
                content: url("${url}") !important;
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

// 注入面板按钮
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
    cropBtn.title = '剪裁图片并覆盖至当前聊天';
    cropBtn.onclick = (e) => { e.stopPropagation(); zoomedDiv.click(); triggerCropPopup(img.src, avatarInfo); };

    // 绑定按钮
    const bindBtn = document.createElement('div');
    bindBtn.id = 'st-bind-btn';
    bindBtn.className = `st-avatar-ctrl-btn ${isBound ? 'is-bound' : ''}`;
    bindBtn.innerHTML = '<i class="fa-solid fa-link"></i>';
    bindBtn.title = isBound ? '已绑定在当前主题 (点击解除绑定并恢复默认)' : '当前未绑定在美化主题';
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
        btnElement.title = '当前未绑定在美化主题';
        toastr.info('已解除该角色/用户在此主题下的头像绑定，恢复默认。');
    } else {
        // 绑定当前图片
        const base64 = await getBase64FromUrl(currentImgSrc);
        const savedUrl = await saveToBackend(base64, `bind_${targetId}`);
        extension_settings.themeBinds[theme][targetId] = savedUrl || currentImgSrc;
        btnElement.classList.add('is-bound');
        btnElement.title = '已绑定在当前主题 (点击解除绑定并恢复默认)';
        toastr.success('当前图片已绑定至此主题的聊天气泡中！');
    }
    
    saveSettingsDebounced();
    applyThemeBinds();
}

// 原生剪裁逻辑
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

        // 自动激活绑定到当前主题
        const theme = getCurrentTheme();
        if (!extension_settings.themeBinds[theme]) extension_settings.themeBinds[theme] = {};
        extension_settings.themeBinds[theme][avatarInfo.id] = savedUrl;
        
        saveSettingsDebounced();
        applyThemeBinds();
        toastr.success('已剪裁并自动绑定到当前主题下的聊天气泡中！');
    }
}

// 独立图库逻辑
async function openGallery(avatarInfo) {
    const id = avatarInfo.id;
    let images = [];
    if (avatarInfo.type === 'user') {
        images = extension_settings.avatarGallery.user;
    } else {
        if (!extension_settings.avatarGallery.chars[id]) extension_settings.avatarGallery.chars[id] = [];
        images = extension_settings.avatarGallery.chars[id];
    }

    const html = `
        <div id="st-alt-avatar-panel">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid var(--SmartThemeBodyColor, #555); padding-bottom: 10px;">
                <h3 style="margin: 0;">${avatarInfo.type === 'user' ? '用户' : '角色'}专属图库</h3>
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
            // 关键：如果你替换了全局头像，必须自动解除当前皮肤里的气泡绑定，否则你依然只能看到旧的绑定图！
            const theme = getCurrentTheme();
            if (extension_settings.themeBinds[theme] && extension_settings.themeBinds[theme][id]) {
                delete extension_settings.themeBinds[theme][id];
                saveSettingsDebounced();
                applyThemeBinds();
                console.log("Cleared local bind to show the newly replaced global avatar.");
            }

            // 触发全局替换！
            triggerNativeUpload(selectedUrl, avatarInfo.type);
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
                
                itemDiv.innerHTML = `<img src="${url}">`;
                
                // 单击选择 / 删除选中
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
                
                // 双击直接确认替换！(UX 优化)
                itemDiv.ondblclick = (e) => {
                    if (!isDeleteMode) {
                        selectedUrl = url;
                        const okBtn = document.getElementById('dialogue_popup_ok');
                        if (okBtn) okBtn.click();
                    }
                };
                
                grid.appendChild(itemDiv);
            });
        }

        document.getElementById('btn-alt-upload').onclick = () => document.getElementById('input-alt-upload').click();
        
        // 上传新图片并存为实体文件
        document.getElementById('input-alt-upload').onchange = async (e) => {
            const files = e.target.files;
            if (!files.length) return;
            toastr.info(`正在处理 ${files.length} 张图片并保存至后端...`);
            
            for(let i = 0; i < files.length; i++) {
                const b64 = await resizeImageToBase64(files[i]);
                const savedUrl = await saveToBackend(b64, `gallery_${id}`);
                if (savedUrl) images.push(savedUrl);
            }
            saveSettingsDebounced();
            renderGrid();
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
                deleteFromBackend(urlToDelete); // 从服务器删除文件

                // 如果被删除的图在绑定中，则解除绑定
                for (const t of Object.keys(extension_settings.themeBinds)) {
                    if (extension_settings.themeBinds[t][id] === urlToDelete) {
                        delete extension_settings.themeBinds[t][id];
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
let lastChar = null;

setInterval(() => {
    // 监听主题或角色的切换，随时更新对应的聊天气泡头像
    const currentTheme = getCurrentTheme();
    const currentCharObj = document.querySelector('.mes_ch_name'); // 判断角色是否变动
    const currentChar = currentCharObj ? currentCharObj.innerText : null;

    if (currentTheme !== lastTheme || currentChar !== lastChar) {
        lastTheme = currentTheme;
        lastChar = currentChar;
        applyThemeBinds();
    }
}, 1000);

jQuery(async () => {
    applyThemeBinds();
    console.log('[Avatar & Gallery Controller] Successfully Loaded.');

    // 监听放大头像弹窗的生成，插入专属按钮
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
