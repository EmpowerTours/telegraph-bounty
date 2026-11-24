// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Wrapped ether with transfer notifications: a contract that receives tokens is told
/// about it through onTokenReceived(from, amount).
contract NotifyToken {
    mapping(address => uint) public balanceOf;
    mapping(address => mapping(address => uint)) public allowance;

    function wrap() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function unwrap(uint amount) external {
        balanceOf[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "send failed");
    }

    function approve(address spender, uint amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint amount) private {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        if (to.code.length > 0) {
            (bool ok,) = to.call(abi.encodeWithSignature("onTokenReceived(address,uint256)", from, amount));
            ok;
        }
    }
}

/// @notice Patched version of HookVault.sol (demo code for this repo only).
/// Custody vault for NotifyToken. Vault balances can be moved between accounts without
/// leaving the vault.
contract HookVault {
    NotifyToken public immutable token;
    mapping(address => uint) public balanceOf;
    uint public totalDeposits;
    bool private locked;

    modifier nonReentrant() {
        require(!locked, "reentrant call");
        locked = true;
        _;
        locked = false;
    }

    constructor() {
        token = new NotifyToken();
    }

    function deposit(uint amount) external nonReentrant {
        require(token.transferFrom(msg.sender, address(this), amount), "pull failed");
        balanceOf[msg.sender] += amount;
        totalDeposits += amount;
    }

    function withdraw(uint amount) external nonReentrant {
        uint bal = balanceOf[msg.sender];
        require(bal >= amount, "insufficient balance");
        balanceOf[msg.sender] = bal - amount;
        totalDeposits -= amount;
        require(token.transfer(msg.sender, amount), "push failed");
    }

    function transfer(address to, uint amount) external nonReentrant {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }
}
