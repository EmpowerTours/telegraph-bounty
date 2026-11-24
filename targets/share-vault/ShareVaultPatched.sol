// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ShareVault
/// @notice Demo bounty target written for this repo only. Patched version of the demo target.
/// Never deploy it with real funds.
/// Tokenized ether vault: depositors receive shares pro rata to the ether they add, and
/// redeem shares for their pro-rata part of the vault's ether. All ether the vault holds
/// (including yield sent to it) belongs to the share holders.
contract ShareVault {
    /// @dev Virtual shares and one virtual wei of assets (decimal offset 9): an empty or
    /// nearly empty vault can no longer be priced so that a later deposit rounds to ~0 shares.
    uint256 internal constant VIRTUAL_SHARES = 1e9;
    uint256 internal constant VIRTUAL_ASSETS = 1;

    mapping(address => uint256) public sharesOf;
    uint256 public totalShares;

    event Deposit(address indexed account, uint256 assets, uint256 shares);
    event Redeem(address indexed account, uint256 shares, uint256 assets);

    function totalAssets() public view returns (uint256) {
        return address(this).balance;
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return _toShares(assets, totalAssets());
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return _toAssets(shares, totalAssets());
    }

    function deposit() external payable returns (uint256 shares) {
        require(msg.value > 0, "zero deposit");
        // msg.value is already part of the balance; price the deposit on the assets before it.
        shares = _toShares(msg.value, totalAssets() - msg.value);
        require(shares > 0, "zero shares");
        sharesOf[msg.sender] += shares;
        totalShares += shares;
        emit Deposit(msg.sender, msg.value, shares);
    }

    function redeem(uint256 shares) external returns (uint256 assets) {
        require(shares > 0, "zero shares");
        require(sharesOf[msg.sender] >= shares, "insufficient shares");
        assets = _toAssets(shares, totalAssets());
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        (bool ok,) = msg.sender.call{value: assets}("");
        require(ok, "transfer failed");
        emit Redeem(msg.sender, shares, assets);
    }

    function _toShares(uint256 assets, uint256 assetsBefore) internal view returns (uint256) {
        return assets * (totalShares + VIRTUAL_SHARES) / (assetsBefore + VIRTUAL_ASSETS);
    }

    function _toAssets(uint256 shares, uint256 assetsNow) internal view returns (uint256) {
        return shares * (assetsNow + VIRTUAL_ASSETS) / (totalShares + VIRTUAL_SHARES);
    }
}
